import { promises as fs, existsSync } from 'node:fs'
import path from 'node:path'
import { fetchMedia } from '../net'
import {
  basenameOfUrl,
  extFromMime,
  extOfUrl,
  isAbortError,
  isMediaExt,
  mapLimit,
  parseContentDisposition,
  sanitizeFilename,
  uniquePath
} from '../../util'
import { sleep, throwIfAborted, type EngineContext } from './types'
import type { DownloadTask } from '@shared/types'

interface PartState {
  start: number
  end: number // -1 = 끝까지
  done: number
}
interface HttpState {
  url: string
  total: number | null
  ranges: boolean
  parts: PartState[]
}

const MIN_SPLIT_SIZE = 4 * 1024 * 1024
const MIN_PART_SIZE = 1024 * 1024
const MAX_RETRY = 6

export function stripMediaExt(name: string): string {
  const ext = path.extname(name).slice(1)
  return ext && isMediaExt(ext) ? name.slice(0, -ext.length - 1) : name
}

export function pickExt(task: DownloadTask, mime: string, dispName: string | null): string {
  const cands = [
    dispName ? path.extname(dispName).slice(1) : '',
    task.filename ? path.extname(task.filename).slice(1) : '',
    extOfUrl(task.url),
    extFromMime(mime) ?? '',
    extFromMime(task.mime) ?? ''
  ]
  for (const c of cands) if (c && isMediaExt(c)) return c.toLowerCase()
  return 'mp4'
}

async function loadState(p: string): Promise<HttpState | null> {
  try {
    return JSON.parse(await fs.readFile(p, 'utf8')) as HttpState
  } catch {
    return null
  }
}

function splitParts(total: number, n: number): PartState[] {
  const count = Math.max(1, Math.min(n, Math.floor(total / MIN_PART_SIZE)))
  const size = Math.ceil(total / count)
  const parts: PartState[] = []
  for (let i = 0; i < count; i++) {
    const start = i * size
    const end = Math.min(total - 1, start + size - 1)
    if (start > end) break
    parts.push({ start, end, done: 0 })
  }
  return parts
}

/** 직접 파일(mp4/webm 등) 다운로드: Range 기반 다중 연결 + 이어받기 */
export async function runHttp(ctx: EngineContext): Promise<string> {
  const { task, signal, settings } = ctx
  const headers = task.headers

  ctx.onProgress({ stage: '연결 중' })
  const probe = await fetchMedia(task.url, { headers, range: 'bytes=0-0', signal, timeoutMs: 30_000 })
  if (!probe.ok) throw new Error(`서버 응답 오류 (HTTP ${probe.status})`)
  const ranges = probe.status === 206
  let total: number | null = null
  if (ranges) {
    const m = /\/(\d+)\s*$/.exec(probe.headers.get('content-range') ?? '')
    if (m) total = Number(m[1])
  } else {
    const cl = probe.headers.get('content-length')
    if (cl && /^\d+$/.test(cl)) total = Number(cl)
  }
  const mime = probe.headers.get('content-type') ?? ''
  const dispName = parseContentDisposition(probe.headers.get('content-disposition'))
  await probe.body?.cancel().catch(() => undefined)
  if (/^text\/html/i.test(mime)) throw new Error('동영상이 아닌 HTML 페이지입니다. 페이지 주소는 yt-dlp 엔진으로 분석해 주세요.')

  let finalPath = task.filePath
  if (!finalPath) {
    const ext = pickExt(task, mime, dispName)
    const rawBase = task.filename || (dispName ? stripMediaExt(dispName) : '') || task.title || stripMediaExt(basenameOfUrl(task.url)) || 'video'
    finalPath = uniquePath(task.outputDir, sanitizeFilename(stripMediaExt(rawBase)), ext)
    ctx.onFile(finalPath)
  }
  await fs.mkdir(path.dirname(finalPath), { recursive: true })
  const partPath = `${finalPath}.part`
  const statePath = `${finalPath}.vdl.json`

  let state = await loadState(statePath)
  const reusable = !!state && state.url === task.url && state.total === total && state.ranges === ranges && existsSync(partPath)
  if (!reusable) {
    const parts =
      ranges && total !== null && total > MIN_SPLIT_SIZE
        ? splitParts(total, settings.connections)
        : [{ start: 0, end: total !== null ? total - 1 : -1, done: 0 }]
    state = { url: task.url, total, ranges, parts }
    await fs.writeFile(partPath, '')
  }
  const st = state!

  const fh = await fs.open(partPath, 'r+')
  let downloaded = st.parts.reduce((a, p) => a + p.done, 0)
  let lastReport = 0
  let lastSave = 0
  const report = (force = false): void => {
    const now = Date.now()
    if (!force && now - lastReport < 100) return
    lastReport = now
    ctx.onProgress({ downloaded, total, stage: '다운로드 중' })
  }
  const saveState = async (): Promise<void> => {
    await fs.writeFile(statePath, JSON.stringify(st)).catch(() => undefined)
  }

  const downloadPart = async (part: PartState): Promise<void> => {
    for (let attempt = 0; ; attempt++) {
      throwIfAborted(signal)
      const remaining = part.end >= 0 ? part.end - part.start - part.done + 1 : Infinity
      if (remaining <= 0) return
      try {
        const from = part.start + part.done
        const range = st.ranges ? `bytes=${from}-${part.end >= 0 ? part.end : ''}` : undefined
        const res = await fetchMedia(task.url, { headers, range, signal, timeoutMs: 30_000 })
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
        if (range && res.status !== 206) {
          if (from === 0 && st.parts.length === 1) {
            // 서버가 Range 를 무시: 처음부터 단일 스트림으로 진행
            st.ranges = false
          } else throw new Error('서버가 이어받기(Range)를 지원하지 않습니다')
        }
        if (!st.ranges && part.done > 0) {
          part.done = 0
          downloaded = 0
        }
        let position = part.start + part.done
        for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
          throwIfAborted(signal)
          let buf: Uint8Array = chunk
          if (part.end >= 0) {
            const room = part.end - position + 1
            if (room <= 0) break
            if (buf.length > room) buf = buf.subarray(0, room)
          }
          await fh.write(buf, 0, buf.length, position)
          position += buf.length
          part.done += buf.length
          downloaded += buf.length
          report()
          const now = Date.now()
          if (now - lastSave > 1000) {
            lastSave = now
            void saveState()
          }
          if (part.end >= 0 && position > part.end) break
        }
        if (part.end >= 0 && part.start + part.done < part.end + 1) throw new Error('연결이 끊어졌습니다')
        return
      } catch (e) {
        if (isAbortError(e) || signal.aborted) throw e
        if (attempt >= MAX_RETRY) throw e
        ctx.log(`part ${part.start} retry ${attempt + 1}: ${e instanceof Error ? e.message : e}`)
        await sleep(1000 * (attempt + 1), signal)
      }
    }
  }

  try {
    report(true)
    await mapLimit(st.parts, st.ranges ? settings.connections : 1, downloadPart)
    await fh.close()
    if (total !== null) await fs.truncate(partPath, total).catch(() => undefined)
    await fs.rename(partPath, finalPath)
    await fs.rm(statePath, { force: true }).catch(() => undefined)
    ctx.onProgress({ downloaded, total: total ?? downloaded, percent: 100, stage: '완료' })
    return finalPath
  } catch (e) {
    await fh.close().catch(() => undefined)
    await saveState()
    throw e
  }
}

export async function cleanupHttp(task: DownloadTask): Promise<void> {
  if (!task.filePath) return
  await fs.rm(`${task.filePath}.part`, { force: true }).catch(() => undefined)
  await fs.rm(`${task.filePath}.vdl.json`, { force: true }).catch(() => undefined)
}
