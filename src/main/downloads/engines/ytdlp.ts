import { spawn } from 'node:child_process'
import readline from 'node:readline'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import { killTree, sanitizeFilename, withTimeout } from '../../util'
import { ffmpegDir } from './ffmpeg'
import { abortError, type EngineContext } from './types'
import type { AnalyzeResult, PreferredQuality, YtdlpFormat } from '@shared/types'

interface RawFormat {
  format_id: string
  ext?: string
  resolution?: string
  width?: number
  height?: number
  fps?: number
  vcodec?: string
  acodec?: string
  filesize?: number | null
  filesize_approx?: number | null
  tbr?: number
  format_note?: string
  protocol?: string
  url?: string
}

interface RawInfo {
  _type?: string
  id?: string
  title?: string
  thumbnail?: string
  duration?: number
  extractor_key?: string
  formats?: RawFormat[]
  entries?: RawInfo[]
  webpage_url?: string
}

function headerArgs(headers: Record<string, string>, cookieFile?: string): string[] {
  const args: string[] = []
  for (const [k, v] of Object.entries(headers)) {
    if (!v) continue
    const key = k.toLowerCase()
    if (key === 'user-agent') args.push('--user-agent', v)
    else if (key === 'cookie' && cookieFile) continue
    else args.push('--add-header', `${k}:${v}`)
  }
  if (cookieFile) args.push('--cookies', cookieFile)
  return args
}

export function mapFormats(raw: RawFormat[] | undefined): YtdlpFormat[] {
  return (raw ?? [])
    .filter((f) => f.format_note !== 'storyboard' && !(f.vcodec === 'none' && f.acodec === 'none'))
    .map((f) => {
      const hasVideo = !!f.vcodec && f.vcodec !== 'none'
      const hasAudio = !!f.acodec && f.acodec !== 'none'
      return {
        formatId: f.format_id,
        ext: f.ext ?? '',
        resolution: f.height ? `${f.width ?? '?'}x${f.height}` : f.resolution,
        fps: f.fps,
        vcodec: f.vcodec,
        acodec: f.acodec,
        filesize: f.filesize ?? f.filesize_approx ?? null,
        tbr: f.tbr,
        note: [f.format_note, f.protocol].filter(Boolean).join(' '),
        hasVideo,
        hasAudio,
        url: f.url,
        protocol: f.protocol
      }
    })
    .reverse()
}

export async function analyzeWithYtdlp(
  ytdlp: string,
  url: string,
  headers: Record<string, string>,
  cookieFile?: string,
  signal?: AbortSignal
): Promise<AnalyzeResult> {
  const args = ['-J', '--no-playlist', '--no-warnings', '--no-colors', ...headerArgs(headers, cookieFile), url]
  const info = await withTimeout(runJson(ytdlp, args, signal), 120_000, '분석 시간이 초과되었습니다')
  let target: RawInfo = info
  if (info._type === 'playlist') {
    const first = info.entries?.find((e) => e && (e.formats?.length || e.title))
    if (!first) throw new Error('재생목록에서 동영상을 찾지 못했습니다')
    target = first
  }
  return {
    kind: 'ytdlp',
    url: target.webpage_url ?? url,
    title: target.title ?? url,
    thumbnail: target.thumbnail,
    duration: target.duration,
    extractor: target.extractor_key,
    formats: mapFormats(target.formats),
    headers,
    cookieFile
  }
}

function runJson(bin: string, args: string[], signal?: AbortSignal): Promise<RawInfo> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => (out += String(d)))
    child.stderr.on('data', (d) => (err += String(d)))
    const onAbort = (): void => killTree(child)
    signal?.addEventListener('abort', onAbort, { once: true })
    child.on('error', (e) => reject(new Error(`yt-dlp 실행 실패: ${e.message}`)))
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort)
      if (signal?.aborted) return reject(abortError())
      if (code !== 0 && !out.trim()) return reject(new Error(cleanError(err) || `yt-dlp 오류 (code ${code})`))
      try {
        resolve(JSON.parse(out) as RawInfo)
      } catch {
        reject(new Error(cleanError(err) || 'yt-dlp 출력을 해석할 수 없습니다'))
      }
    })
  })
}

function cleanError(stderr: string): string {
  const lines = stderr
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith('ERROR'))
  const last = lines[lines.length - 1] ?? ''
  return last.replace(/^ERROR:\s*/, '').replace(/^\[[^\]]+\]\s*[^:]*:\s*/, '')
}

export function buildSelector(formatId: string | undefined, formats: YtdlpFormat[] | undefined, pref: PreferredQuality): string {
  if (formatId && formatId !== 'best') {
    const f = formats?.find((x) => x.formatId === formatId)
    if (f && f.hasVideo && !f.hasAudio) return `${formatId}+bestaudio/${formatId}/best`
    return `${formatId}/best`
  }
  switch (pref) {
    case 'worst':
      return 'worstvideo*+worstaudio/worst'
    case '1080':
    case '720':
    case '480':
      return `bestvideo*[height<=${pref}]+bestaudio/best[height<=${pref}]/best`
    default:
      return 'bestvideo*+bestaudio/best'
  }
}

export async function runYtdlp(ctx: EngineContext): Promise<string> {
  const { task, signal, settings, tools } = ctx
  if (!tools.ytdlp) throw new Error('yt-dlp 를 찾을 수 없습니다. 설정 > 도구에서 설치해 주세요.')
  await fs.mkdir(task.outputDir, { recursive: true })
  const base = task.filename ? sanitizeFilename(task.filename) : ''
  const template = path.join(task.outputDir, base ? `${base}.%(ext)s` : '%(title).150B [%(id)s].%(ext)s')
  const args = [
    '--newline',
    '--no-colors',
    '--no-playlist',
    '--no-simulate',
    '--windows-filenames',
    '--retries',
    '5',
    '--fragment-retries',
    '10',
    '--concurrent-fragments',
    String(Math.max(1, Math.min(16, settings.connections))),
    '--progress-template',
    'download:__DL__%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.fragment_index)s|%(progress.fragment_count)s',
    '--print',
    'after_move:__OUT__%(filepath)s',
    '-o',
    template,
    '-f',
    task.formatId || buildSelector(undefined, undefined, settings.preferredQuality)
  ]
  if (settings.remuxToMp4) args.push('--merge-output-format', 'mp4')
  if (tools.ffmpeg) args.push('--ffmpeg-location', ffmpegDir(tools.ffmpeg))
  args.push(...headerArgs(task.headers, task.cookieFile), task.url)

  ctx.log(`yt-dlp ${args.join(' ')}`)
  return new Promise<string>((resolve, reject) => {
    if (signal.aborted) return reject(abortError())
    const child = spawn(tools.ytdlp!, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32'
    })
    let outPath = ''
    let lastDest = ''
    let errText = ''
    const onAbort = (): void => killTree(child)
    signal.addEventListener('abort', onAbort, { once: true })

    const handleLine = (line: string): void => {
      if (line.startsWith('__DL__')) {
        const [dl, total, est, fi, fc] = line.slice(6).split('|')
        const num = (s: string | undefined): number | null => (s && s !== 'NA' && s !== 'None' ? Number(s) : null)
        const downloaded = num(dl) ?? 0
        const t = num(total) ?? num(est)
        ctx.onProgress({
          downloaded,
          total: t,
          segmentsDone: num(fi) ?? undefined,
          segmentsTotal: num(fc) ?? undefined,
          stage: '다운로드 중'
        })
        return
      }
      if (line.startsWith('__OUT__')) {
        outPath = line.slice(7).trim()
        return
      }
      let m = /^\[download\] Destination: (.+)$/.exec(line)
      if (m) {
        lastDest = m[1].trim()
        ctx.onFile(lastDest)
        return
      }
      m = /^\[Merger\] Merging formats into "(.+)"$/.exec(line)
      if (m) {
        lastDest = m[1]
        ctx.onProgress({ stage: '병합 중' })
        return
      }
      m = /^\[download\] (.+) has already been downloaded$/.exec(line)
      if (m) {
        lastDest = m[1].trim()
        return
      }
      if (/^\[(ffmpeg|VideoRemuxer|ExtractAudio|FixupM3u8|FixupM4a)\]/.test(line)) ctx.onProgress({ stage: '후처리 중' })
      if (line.startsWith('ERROR')) errText = line
      ctx.log(line)
    }
    readline.createInterface({ input: child.stdout }).on('line', handleLine)
    readline.createInterface({ input: child.stderr }).on('line', (l) => {
      if (l.startsWith('ERROR')) errText = l
      ctx.log(l)
    })
    child.on('error', (e) => {
      signal.removeEventListener('abort', onAbort)
      reject(new Error(`yt-dlp 실행 실패: ${e.message}`))
    })
    child.on('close', (code) => {
      signal.removeEventListener('abort', onAbort)
      if (signal.aborted) return reject(abortError())
      const finalPath = outPath || lastDest
      if (code === 0 && finalPath) {
        ctx.onFile(finalPath)
        ctx.onProgress({ percent: 100, stage: '완료' })
        return resolve(finalPath)
      }
      reject(new Error(cleanError(errText) || `yt-dlp 오류 (code ${code})`))
    })
  })
}
