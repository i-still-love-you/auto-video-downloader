import { promises as fs, existsSync, createWriteStream } from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fetchMedia } from '../net'
import { ensureDir, fileSize, isAbortError, mapLimit, rmrf, sanitizeFilename, uniquePath } from '../../util'
import { runFfmpeg } from './ffmpeg'
import { sleep, throwIfAborted, type EngineContext } from './types'
import type { DownloadTask, HlsVariant, PreferredQuality } from '@shared/types'

// ---------- m3u8 파서 ----------

export interface HlsKey {
  method: string
  uri?: string
  iv?: string
}
export interface ByteRange {
  length: number
  offset: number
}
export interface HlsSegment {
  uri: string
  duration: number
  seq: number
  key?: HlsKey
  byterange?: ByteRange
}
export interface MediaPlaylist {
  type: 'media'
  segments: HlsSegment[]
  map?: { uri: string; byterange?: ByteRange }
  live: boolean
  totalDuration: number
}
export interface AudioRendition {
  groupId: string
  name: string
  uri?: string
  isDefault: boolean
}
export interface MasterPlaylist {
  type: 'master'
  variants: HlsVariant[]
  audio: AudioRendition[]
}

export function parseAttrs(s: string): Record<string, string> {
  const out: Record<string, string> = {}
  const re = /([A-Z0-9-]+)=("([^"]*)"|([^,]*))/g
  let m: RegExpExecArray | null
  while ((m = re.exec(s))) out[m[1]] = m[3] ?? m[4] ?? ''
  return out
}

function resolve(uri: string, base: string): string {
  try {
    return new URL(uri, base).href
  } catch {
    return uri
  }
}

function parseByteRange(v: string, prevEnd: number): ByteRange {
  const [len, off] = v.split('@')
  const length = Number(len)
  const offset = off !== undefined ? Number(off) : prevEnd
  return { length, offset }
}

export function parsePlaylist(text: string, baseUrl: string): MasterPlaylist | MediaPlaylist {
  const lines = text.split(/\r?\n/).map((l) => l.trim())
  if (!lines.some((l) => l.startsWith('#EXTM3U'))) throw new Error('올바른 m3u8 재생목록이 아닙니다')
  if (lines.some((l) => l.startsWith('#EXT-X-STREAM-INF'))) return parseMaster(lines, baseUrl)
  return parseMedia(lines, baseUrl)
}

function parseMaster(lines: string[], baseUrl: string): MasterPlaylist {
  const variants: HlsVariant[] = []
  const audio: AudioRendition[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.startsWith('#EXT-X-MEDIA:')) {
      const a = parseAttrs(line.slice('#EXT-X-MEDIA:'.length))
      if (a.TYPE === 'AUDIO') {
        audio.push({
          groupId: a['GROUP-ID'] ?? '',
          name: a.NAME ?? '',
          uri: a.URI ? resolve(a.URI, baseUrl) : undefined,
          isDefault: a.DEFAULT === 'YES'
        })
      }
    } else if (line.startsWith('#EXT-X-STREAM-INF:')) {
      const a = parseAttrs(line.slice('#EXT-X-STREAM-INF:'.length))
      let j = i + 1
      while (j < lines.length && (lines[j] === '' || lines[j].startsWith('#'))) j++
      if (j >= lines.length) break
      variants.push({
        uri: resolve(lines[j], baseUrl),
        bandwidth: Number(a.BANDWIDTH ?? a['AVERAGE-BANDWIDTH'] ?? 0),
        resolution: a.RESOLUTION,
        codecs: a.CODECS,
        frameRate: a['FRAME-RATE'] ? Number(a['FRAME-RATE']) : undefined,
        audioGroup: a.AUDIO,
        name: a.NAME
      })
      i = j
    }
  }
  for (const v of variants) {
    if (!v.audioGroup) continue
    const group = audio.filter((r) => r.groupId === v.audioGroup && r.uri)
    const pick = group.find((r) => r.isDefault) ?? group[0]
    if (pick?.uri) v.audioUri = pick.uri
  }
  const seen = new Set<string>()
  const unique = variants.filter((v) => (seen.has(v.uri) ? false : (seen.add(v.uri), true)))
  unique.sort((a, b) => heightOf(b) - heightOf(a) || b.bandwidth - a.bandwidth)
  return { type: 'master', variants: unique, audio }
}

function parseMedia(lines: string[], baseUrl: string): MediaPlaylist {
  const segments: HlsSegment[] = []
  let key: HlsKey | undefined
  let map: MediaPlaylist['map']
  let duration = 0
  let seq = 0
  let live = true
  let pendingRange: ByteRange | undefined
  let prevEnd = 0
  let total = 0
  for (const line of lines) {
    if (!line) continue
    if (line.startsWith('#EXTINF:')) {
      duration = parseFloat(line.slice(8)) || 0
    } else if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      seq = parseInt(line.slice(22), 10) || 0
    } else if (line.startsWith('#EXT-X-KEY:')) {
      const a = parseAttrs(line.slice(11))
      key = a.METHOD === 'NONE' ? undefined : { method: a.METHOD ?? 'NONE', uri: a.URI ? resolve(a.URI, baseUrl) : undefined, iv: a.IV }
    } else if (line.startsWith('#EXT-X-MAP:')) {
      const a = parseAttrs(line.slice(11))
      map = { uri: resolve(a.URI ?? '', baseUrl), byterange: a.BYTERANGE ? parseByteRange(a.BYTERANGE, 0) : undefined }
    } else if (line.startsWith('#EXT-X-BYTERANGE:')) {
      pendingRange = parseByteRange(line.slice(17), prevEnd)
    } else if (line.startsWith('#EXT-X-ENDLIST')) {
      live = false
    } else if (line.startsWith('#')) {
      continue
    } else {
      const seg: HlsSegment = { uri: resolve(line, baseUrl), duration, seq, key, byterange: pendingRange }
      if (pendingRange) prevEnd = pendingRange.offset + pendingRange.length
      pendingRange = undefined
      segments.push(seg)
      total += duration
      seq++
      duration = 0
    }
  }
  return { type: 'media', segments, map, live, totalDuration: total }
}

export function heightOf(v: HlsVariant): number {
  const m = /(\d+)x(\d+)/.exec(v.resolution ?? '')
  return m ? Number(m[2]) : 0
}

export function pickVariant(variants: HlsVariant[], pref: PreferredQuality): HlsVariant {
  if (!variants.length) throw new Error('재생 가능한 화질이 없습니다')
  const sorted = [...variants].sort((a, b) => heightOf(b) - heightOf(a) || b.bandwidth - a.bandwidth)
  if (pref === 'worst') return sorted[sorted.length - 1]
  if (pref === 'best' || pref === 'ask') return sorted[0]
  const limit = Number(pref)
  return sorted.find((v) => heightOf(v) <= limit || heightOf(v) === 0) ?? sorted[sorted.length - 1]
}

export function variantLabel(v: HlsVariant): string {
  const parts: string[] = []
  if (v.resolution) parts.push(v.resolution)
  if (v.frameRate) parts.push(`${Math.round(v.frameRate)}fps`)
  if (v.bandwidth) parts.push(`${(v.bandwidth / 1000).toFixed(0)} kbps`)
  if (v.name) parts.push(v.name)
  return parts.join(' · ') || v.uri
}

// ---------- 네트워크 ----------

export async function fetchText(url: string, headers: Record<string, string>, signal?: AbortSignal): Promise<string> {
  const res = await fetchMedia(url, { headers, signal, timeoutMs: 30_000 })
  if (!res.ok) throw new Error(`재생목록 요청 실패 (HTTP ${res.status})`)
  return res.text()
}

async function fetchBuffer(url: string, headers: Record<string, string>, signal: AbortSignal, range?: ByteRange): Promise<Buffer> {
  const rangeHeader = range ? `bytes=${range.offset}-${range.offset + range.length - 1}` : undefined
  const res = await fetchMedia(url, { headers, signal, range: rangeHeader, timeoutMs: 60_000 })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return Buffer.from(await res.arrayBuffer())
}

async function withRetry<T>(fn: () => Promise<T>, signal: AbortSignal, label: string, log: (s: string) => void): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    throwIfAborted(signal)
    try {
      return await fn()
    } catch (e) {
      if (isAbortError(e) || signal.aborted || attempt >= 5) throw e
      log(`${label} 재시도 ${attempt + 1}: ${e instanceof Error ? e.message : e}`)
      await sleep(800 * (attempt + 1), signal)
    }
  }
}

function checkKeys(pl: MediaPlaylist): void {
  for (const s of pl.segments) {
    const m = s.key?.method
    if (m && m !== 'AES-128' && m !== 'NONE') {
      throw new Error(`${m} 암호화(DRM) 스트림은 지원하지 않습니다`)
    }
  }
}

function ivFor(seg: HlsSegment): Buffer {
  if (seg.key?.iv) {
    const hex = seg.key.iv.replace(/^0x/i, '').padStart(32, '0')
    return Buffer.from(hex, 'hex')
  }
  const iv = Buffer.alloc(16)
  iv.writeUInt32BE(seg.seq >>> 0, 12)
  return iv
}

// ---------- 엔진 ----------

export async function runHls(ctx: EngineContext): Promise<string> {
  const { task, signal, settings, workDir, tools } = ctx
  const headers = task.headers
  await ensureDir(workDir)

  ctx.onProgress({ stage: '재생목록 분석 중' })
  let videoUrl = task.url
  let audioUrl = task.variant?.audioUri
  let parsed = parsePlaylist(await fetchText(task.url, headers, signal), task.url)
  if (parsed.type === 'master') {
    const variant = task.variant ?? pickVariant(parsed.variants, settings.preferredQuality)
    videoUrl = variant.uri
    audioUrl = variant.audioUri
    parsed = parsePlaylist(await fetchText(videoUrl, headers, signal), videoUrl)
    if (parsed.type === 'master') throw new Error('중첩된 마스터 재생목록은 지원하지 않습니다')
  }
  const video = parsed
  if (video.live) throw new Error('라이브(종료되지 않은) 스트림은 지원하지 않습니다')
  if (!video.segments.length) throw new Error('재생목록에 세그먼트가 없습니다')
  checkKeys(video)

  let audio: MediaPlaylist | undefined
  if (audioUrl) {
    const a = parsePlaylist(await fetchText(audioUrl, headers, signal), audioUrl)
    if (a.type === 'media' && a.segments.length && !a.live) {
      checkKeys(a)
      audio = a
    }
  }

  const streams: Array<{ name: string; pl: MediaPlaylist }> = [{ name: 'v', pl: video }]
  if (audio) streams.push({ name: 'a', pl: audio })
  const segmentsTotal = streams.reduce((n, s) => n + s.pl.segments.length, 0)
  let segmentsDone = 0
  let downloaded = 0
  const keyCache = new Map<string, Promise<Buffer>>()
  const getKey = (uri: string): Promise<Buffer> => {
    let p = keyCache.get(uri)
    if (!p) {
      p = withRetry(() => fetchBuffer(uri, headers, signal), signal, '키', ctx.log)
      keyCache.set(uri, p)
    }
    return p
  }
  const report = (): void => {
    const estimate = segmentsDone >= 3 ? Math.round((downloaded / segmentsDone) * segmentsTotal) : null
    ctx.onProgress({
      downloaded,
      total: estimate,
      segmentsDone,
      segmentsTotal,
      percent: Math.min(99, (segmentsDone / segmentsTotal) * 100),
      stage: '세그먼트 다운로드 중'
    })
  }

  const downloadSegment = async (dir: string, seg: HlsSegment, index: number): Promise<void> => {
    const file = path.join(dir, `${String(index).padStart(6, '0')}.bin`)
    const existing = await fileSize(file)
    if (existing > 0) {
      downloaded += existing
      segmentsDone++
      report()
      return
    }
    let data = await withRetry(() => fetchBuffer(seg.uri, headers, signal, seg.byterange), signal, `세그먼트 ${index}`, ctx.log)
    if (seg.key?.method === 'AES-128' && seg.key.uri) {
      const key = await getKey(seg.key.uri)
      const d = crypto.createDecipheriv('aes-128-cbc', key, ivFor(seg))
      data = Buffer.concat([d.update(data), d.final()])
    }
    const tmp = `${file}.tmp`
    await fs.writeFile(tmp, data)
    await fs.rename(tmp, file)
    downloaded += data.length
    segmentsDone++
    report()
  }

  report()
  for (const s of streams) {
    const dir = path.join(workDir, s.name)
    await ensureDir(dir)
    if (s.pl.map) {
      const initFile = path.join(dir, 'init.bin')
      if ((await fileSize(initFile)) === 0) {
        const data = await withRetry(() => fetchBuffer(s.pl.map!.uri, headers, signal, s.pl.map!.byterange), signal, 'init', ctx.log)
        await fs.writeFile(initFile, data)
      }
    }
    await mapLimit(s.pl.segments, settings.connections, (seg, i) => downloadSegment(dir, seg, i))
  }
  throwIfAborted(signal)

  // 세그먼트 결합
  ctx.onProgress({ stage: '세그먼트 결합 중' })
  const assembled: string[] = []
  for (const s of streams) {
    const dir = path.join(workDir, s.name)
    const ext = s.pl.map ? 'mp4' : 'ts'
    const out = path.join(workDir, `${s.name}.${ext}`)
    await concatFiles(
      [...(s.pl.map ? [path.join(dir, 'init.bin')] : []), ...s.pl.segments.map((_, i) => path.join(dir, `${String(i).padStart(6, '0')}.bin`))],
      out,
      signal
    )
    assembled.push(out)
  }

  const base = sanitizeFilename(task.filename || task.title || 'video')
  let finalPath = task.filePath
  if (tools.ffmpeg) {
    if (!finalPath || path.extname(finalPath).toLowerCase() !== '.mp4') finalPath = uniquePath(task.outputDir, base, 'mp4')
    ctx.onFile(finalPath)
    await ensureDir(task.outputDir)
    ctx.onProgress({ stage: 'MP4 변환 중', percent: 99 })
    await runFfmpeg({
      ffmpeg: tools.ffmpeg,
      inputs: assembled,
      output: finalPath,
      durationSec: video.totalDuration,
      signal,
      onProgress: (pct) => ctx.onProgress({ stage: 'MP4 변환 중', percent: pct === null ? 99 : Math.max(99, pct) })
    })
  } else {
    const ext = video.map ? 'mp4' : 'ts'
    if (!finalPath) finalPath = uniquePath(task.outputDir, base, ext)
    ctx.onFile(finalPath)
    await ensureDir(task.outputDir)
    await fs.copyFile(assembled[0], finalPath)
    if (assembled[1]) {
      const audioOut = uniquePath(task.outputDir, `${base} (audio)`, audio?.map ? 'm4a' : 'aac')
      await fs.copyFile(assembled[1], audioOut)
      ctx.log('ffmpeg 가 없어 오디오를 별도 파일로 저장했습니다')
    }
  }
  await rmrf(workDir)
  ctx.onProgress({ downloaded, total: downloaded, percent: 100, segmentsDone, segmentsTotal, stage: '완료' })
  return finalPath
}

async function concatFiles(files: string[], out: string, signal: AbortSignal): Promise<void> {
  const ws = createWriteStream(out)
  try {
    for (const f of files) {
      throwIfAborted(signal)
      if (!existsSync(f)) throw new Error(`세그먼트 파일 누락: ${path.basename(f)}`)
      const data = await fs.readFile(f)
      if (!ws.write(data)) await new Promise<void>((r) => ws.once('drain', () => r()))
    }
  } finally {
    await new Promise<void>((resolve, reject) => {
      ws.end(() => resolve())
      ws.on('error', reject)
    })
  }
}

export async function cleanupHls(task: DownloadTask, workDir: string): Promise<void> {
  await rmrf(workDir)
  if (task.filePath && task.status !== 'completed') await fs.rm(task.filePath, { force: true }).catch(() => undefined)
}
