import { app } from 'electron'
import { spawn } from 'node:child_process'
import { existsSync, promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { toolPath } from './tools/binaries'
import { allowMediaRoot, mediaUrlFor } from './protocols'
import { ensureDir, killTree, newId, rmrf } from './util'
import { fetchText, parsePlaylist, pickVariant } from './downloads/engines/hls'
import { DEFAULT_UA, headerValue } from './downloads/net'
import type { ThumbnailCacheInfo, ThumbnailResult } from '@shared/types'

const WIDTH = 320
const MAX_PARALLEL = 2
const LOCAL_TIMEOUT = 20_000
const REMOTE_TIMEOUT = 30_000

const inflight = new Map<string, Promise<string | null>>()
let active = 0
const waiting: Array<() => void> = []

export function thumbsDir(): string {
  return path.join(app.getPath('userData'), 'thumbs')
}

export function initThumbnails(): void {
  allowMediaRoot(thumbsDir())
}

function hash(s: string): string {
  return crypto.createHash('sha1').update(s).digest('hex')
}

async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= MAX_PARALLEL) await new Promise<void>((r) => waiting.push(r))
  active++
  try {
    return await fn()
  } finally {
    active--
    waiting.shift()?.()
  }
}

function dedupe(key: string, fn: () => Promise<string | null>): Promise<string | null> {
  let p = inflight.get(key)
  if (!p) {
    p = fn().finally(() => inflight.delete(key))
    inflight.set(key, p)
  }
  return p
}

function run(bin: string, args: string[], timeoutMs: number): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => killTree(child), timeoutMs)
    child.stdout?.on('data', (d) => (stdout += String(d)))
    child.stderr?.on('data', (d) => (stderr += String(d)))
    child.on('error', () => {
      clearTimeout(timer)
      resolve({ ok: false, stdout, stderr })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ ok: code === 0, stdout, stderr })
    })
  })
}

function ffprobeFor(ffmpeg: string): string | null {
  const dir = path.dirname(ffmpeg)
  const name = process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe'
  const p = path.join(dir, name)
  return existsSync(p) ? p : null
}

async function probeDuration(ffmpeg: string, file: string): Promise<number | null> {
  const ffprobe = ffprobeFor(ffmpeg)
  if (!ffprobe) return null
  const r = await run(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], 10_000)
  const n = parseFloat(r.stdout.trim())
  return r.ok && Number.isFinite(n) && n > 0 ? n : null
}

async function grab(ffmpeg: string, input: string, out: string, seek: number, inputArgs: string[], timeoutMs: number): Promise<boolean> {
  await fs.rm(out, { force: true }).catch(() => undefined)
  const args = [
    '-y', '-hide_banner', '-loglevel', 'error', '-nostdin',
    ...inputArgs,
    '-ss', String(seek),
    '-i', input,
    '-map', '0:v:0',
    '-frames:v', '1',
    '-vf', `scale=${WIDTH}:-2`,
    '-q:v', '5',
    '-f', 'image2',
    out
  ]
  const r = await run(ffmpeg, args, timeoutMs)
  if (!r.ok) return false
  try {
    return (await fs.stat(out)).size > 0
  } catch {
    return false
  }
}

/** 다운로드 폴더 등 로컬 동영상의 썸네일. 캐시되어 있으면 즉시 반환. */
export async function localThumbnail(file: string): Promise<ThumbnailResult> {
  let st: { size: number; mtimeMs: number }
  try {
    st = await fs.stat(file)
  } catch {
    return { url: null, canFallback: false }
  }
  const key = hash(`local|${file}|${st.size}|${Math.floor(st.mtimeMs)}`)
  const out = path.join(thumbsDir(), `${key}.jpg`)
  if (existsSync(out)) return { url: mediaUrlFor(out), canFallback: false }
  const ffmpeg = await toolPath('ffmpeg')
  if (!ffmpeg) return { url: null, canFallback: true }
  const result = await dedupe(key, () =>
    withSlot(async () => {
      await ensureDir(thumbsDir())
      const duration = await probeDuration(ffmpeg, file)
      const seeks = duration ? [Math.min(30, Math.max(1, duration * 0.1)), 0] : [5, 1, 0]
      for (const s of seeks) {
        if (await grab(ffmpeg, file, out, s, [], LOCAL_TIMEOUT)) return out
      }
      return null
    })
  )
  return { url: result ? mediaUrlFor(result) : null, canFallback: !result }
}

/** 원격 동영상(mp4 등 직접 파일, m3u8)의 썸네일. 헤더를 전달해 ffmpeg 로 프레임 하나를 뽑는다. */
export async function remoteThumbnail(url: string, headers: Record<string, string> = {}): Promise<string | null> {
  if (!/^https?:\/\//i.test(url)) return null
  const key = hash(`remote|${url}`)
  const out = path.join(thumbsDir(), `${key}.jpg`)
  if (existsSync(out)) return mediaUrlFor(out)
  const ffmpeg = await toolPath('ffmpeg')
  if (!ffmpeg) return null
  return dedupe(key, () =>
    withSlot(async () => {
      await ensureDir(thumbsDir())
      let input = url
      let isHls = /\.m3u8(\?|$)/i.test(url)
      if (isHls) {
        try {
          const parsed = parsePlaylist(await fetchText(url, headers), url)
          if (parsed.type === 'master') input = pickVariant(parsed.variants, 'worst').uri
        } catch {
          /* 그대로 시도 */
        }
      } else {
        try {
          const head = await fetch(url, { method: 'GET', headers: { ...headers, Range: 'bytes=0-0' }, signal: AbortSignal.timeout(8000) })
          const ct = head.headers.get('content-type') ?? ''
          await head.body?.cancel().catch(() => undefined)
          if (/mpegurl/i.test(ct)) {
            isHls = true
            const parsed = parsePlaylist(await fetchText(url, headers), url)
            if (parsed.type === 'master') input = pickVariant(parsed.variants, 'worst').uri
          }
        } catch {
          /* ignore */
        }
      }
      const ua = headerValue(headers, 'user-agent') ?? DEFAULT_UA
      const lines = Object.entries(headers)
        .filter(([k, v]) => v && !/^user-agent$/i.test(k))
        .map(([k, v]) => `${k}: ${v}`)
        .join('\r\n')
      const inputArgs = ['-user_agent', ua, '-rw_timeout', '15000000']
      if (lines) inputArgs.push('-headers', `${lines}\r\n`)
      if (isHls) inputArgs.push('-allowed_extensions', 'ALL')
      for (const s of [3, 0]) {
        if (await grab(ffmpeg, input, out, s, inputArgs, REMOTE_TIMEOUT)) return mediaUrlFor(out)
      }
      return null
    })
  )
}

/** 캐시에 남기지 않고 JPEG 버퍼만 만든다 (개인 폴더용). */
export async function thumbnailBuffer(file: string): Promise<Buffer | null> {
  const ffmpeg = await toolPath('ffmpeg')
  if (!ffmpeg) return null
  const tmp = path.join(os.tmpdir(), `vdl-thumb-${newId()}.jpg`)
  try {
    return await withSlot(async () => {
      const duration = await probeDuration(ffmpeg, file)
      const seeks = duration ? [Math.min(30, Math.max(1, duration * 0.1)), 0] : [5, 1, 0]
      for (const s of seeks) {
        if (await grab(ffmpeg, file, tmp, s, [], LOCAL_TIMEOUT)) return fs.readFile(tmp)
      }
      return null
    })
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => undefined)
  }
}

/** 렌더러가 canvas 로 캡처한 data URL 을 캐시에 저장한다. */
export async function storeThumbnail(file: string, dataUrl: string): Promise<string> {
  const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl)
  if (!m) throw new Error('올바른 이미지 데이터가 아닙니다')
  const buf = Buffer.from(m[2], 'base64')
  if (buf.length > 2 * 1024 * 1024) throw new Error('썸네일이 너무 큽니다')
  const st = await fs.stat(file)
  const key = hash(`local|${file}|${st.size}|${Math.floor(st.mtimeMs)}`)
  await ensureDir(thumbsDir())
  const out = path.join(thumbsDir(), `${key}.jpg`)
  await fs.writeFile(out, buf)
  return mediaUrlFor(out)
}

export async function cacheInfo(): Promise<ThumbnailCacheInfo> {
  try {
    const files = await fs.readdir(thumbsDir())
    let bytes = 0
    for (const f of files) {
      try {
        bytes += (await fs.stat(path.join(thumbsDir(), f))).size
      } catch {
        /* ignore */
      }
    }
    return { count: files.length, bytes }
  } catch {
    return { count: 0, bytes: 0 }
  }
}

export async function clearCache(): Promise<void> {
  await rmrf(thumbsDir())
}

/** 로컬 파일의 길이(초). ffprobe 가 없거나 읽지 못하면 null. */
export async function localDuration(file: string): Promise<number | null> {
  const ffmpeg = await toolPath('ffmpeg')
  if (!ffmpeg) return null
  try {
    return await probeDuration(ffmpeg, file)
  } catch {
    return null
  }
}
