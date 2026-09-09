import { EventEmitter } from 'node:events'
import path from 'node:path'
import { webContents, type OnHeadersReceivedListenerDetails, type Session } from 'electron'
import type { DetectedMedia, MediaKind, ScanPayload } from '@shared/types'
import { basenameOfUrl, errorMessage, extOfUrl, isMediaExt, mimeFromExt, newId, parseContentDisposition } from '../util'
import { cookieHeaderFor } from '../downloads/net'
import { getSettings } from '../settings'
import { Prober } from './prober'

const SKIP_EXT = new Set([
  'ts', 'm4s', 'm4f', 'vtt', 'srt', 'key', 'jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'ico', 'js', 'css', 'html',
  'htm', 'json', 'xml', 'txt', 'woff', 'woff2', 'ttf', 'map'
])
/** 이름만으로 세그먼트임이 드러나는 경우: seg-3, chunk_12, frag7, init.mp4, 12.m4s */
const SEGMENT_NAME = /(?:^|[/_\-.])(?:seg(?:ment)?|chunk|frag(?:ment)?|piece)[-_]?\d+|\/init(?:-[\w]+)?\.mp4$|\/\d+\.m4s$/i
/** 번호만 붙은 이름: 세그먼트(video_00012.mp4)일 수도, 작품 번호가 붙은 파일(abcd-019.mp4)일 수도 있어 크기·요청 종류로 가른다 */
const NUMBERED_NAME = /[-_]\d{2,}\.(?:m4s|mp4)$/i
/** 번호만 붙은 이름이라도 전체 크기가 이보다 크면 파일로 본다 (HLS/DASH 조각은 보통 몇 MB 이하) */
const WHOLE_FILE_MIN = 32 * 1024 * 1024
const MAX_PER_TAB = 200
/** VDL_DEBUG_SNIFF=1: 미디어로 보이는 응답마다 판정 과정을 기록한다 (smoke 리포트의 sniffLog 에도 포함) */
const DEBUG = !!process.env.VDL_DEBUG_SNIFF
export const debugLog: string[] = []
function dlog(line: string): void {
  if (!DEBUG) return
  debugLog.push(line)
  if (debugLog.length > 500) debugLog.shift()
  console.log(`[sniff] ${line}`)
}

export interface Classified {
  kind: MediaKind
  mime: string
  size: number | null
  filename: string | null
}

export interface ClassifyHint {
  /** webRequest 의 resourceType. 'media' 는 <video>/<audio> 요소가 통째로 재생하는 응답이므로 세그먼트가 아니다 (MSE 조각은 xhr/fetch 로 온다) */
  resourceType?: string
  /** 사용자가 직접 지정한 주소처럼 세그먼트일 리 없는 경우 */
  wholeFile?: boolean
}

/**
 * 응답 헤더와 URL만 보고 미디어 여부를 판별한다.
 * 이름이 세그먼트처럼 보이는 파일은 제외하되, 요소가 직접 재생하는 응답이거나 전체 크기가 충분히 크면 파일로 본다.
 */
export function classify(url: string, mime: string, size: number | null, disposition?: string, hint?: ClassifyHint): Classified | null {
  const m = (mime || '').split(';')[0].trim().toLowerCase()
  const ext = extOfUrl(url)
  const dispName = parseContentDisposition(disposition)
  const dispExt = dispName ? path.extname(dispName).slice(1).toLowerCase() : ''

  if (m.includes('mpegurl') || ext === 'm3u8' || dispExt === 'm3u8') {
    return { kind: 'hls', mime: m || 'application/vnd.apple.mpegurl', size, filename: dispName }
  }
  if (m === 'application/dash+xml' || ext === 'mpd' || dispExt === 'mpd') {
    return { kind: 'dash', mime: m || 'application/dash+xml', size, filename: dispName }
  }
  if (m === 'video/mp2t' || m === 'video/iso.segment' || m === 'text/vtt' || SKIP_EXT.has(ext)) return null

  let isMedia = m.startsWith('video/') || m.startsWith('audio/') || m === 'application/mp4' || m === 'application/x-mp4'
  const vague = ['', 'application/octet-stream', 'binary/octet-stream', 'application/force-download', 'application/download']
  if (!isMedia && vague.includes(m) && (isMediaExt(ext) || isMediaExt(dispExt))) isMedia = true
  if (!isMedia) return null

  let pathname = ''
  try {
    pathname = new URL(url).pathname
  } catch {
    return null
  }
  const whole = hint?.wholeFile || hint?.resourceType === 'media'
  if (!whole) {
    if (SEGMENT_NAME.test(pathname)) return null
    if (NUMBERED_NAME.test(pathname) && !(size !== null && size >= WHOLE_FILE_MIN)) return null
  }

  const filename = dispName ?? (isMediaExt(ext) ? basenameOfUrl(url) : null)
  return { kind: 'file', mime: m || mimeFromExt(ext || dispExt || 'mp4'), size, filename }
}

function lowerHeaders(h: Record<string, string[] | string> | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!h) return out
  for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = Array.isArray(v) ? v[0] : v
  return out
}

function totalSize(h: Record<string, string>): number | null {
  const cr = h['content-range']
  if (cr) {
    const m = /\/(\d+)\s*$/.exec(cr)
    if (m) return Number(m[1])
  }
  const cl = h['content-length']
  if (cl && /^\d+$/.test(cl)) return Number(cl)
  return null
}

const KEEP_REQUEST_HEADERS = ['referer', 'origin', 'user-agent', 'cookie', 'accept-language', 'authorization']

/**
 * 브라우저 탭들의 네트워크 응답을 감시해 동영상 소스를 찾아낸다. 탭마다 세션이 다를 수 있으므로
 * 쿠키와 User-Agent 는 요청을 보낸 탭의 세션에서 읽는다.
 * webRequest 리스너는 세션당 하나만 허용되므로 직접 등록하지 않고, 세션 소유자가
 * handleBeforeSendHeaders / handleHeadersReceived 를 자기 리스너 안에서 호출한다.
 * 이벤트: 'detected' (DetectedMedia), 'updated' (DetectedMedia, 사전 조회 결과 등 갱신), 'changed' (tabId)
 */
export class Sniffer extends EventEmitter {
  private byTab = new Map<number, DetectedMedia[]>()
  private seen = new Map<number, Set<string>>()
  private reqHeaders = new Map<number, Record<string, string>>()
  private reqOrder: number[] = []
  private prober = new Prober((item) => {
    // 그 사이 탭이 이동해 목록에서 빠진 항목이면 알리지 않는다
    if (this.byTab.get(item.tabId)?.includes(item)) this.emit('updated', item)
  })

  constructor(private readonly isTab: (id: number) => boolean) {
    super()
  }

  private needsProbe(item: DetectedMedia): boolean {
    if (item.probe) return false
    if (item.kind === 'hls') return true
    return item.kind === 'file' && item.size === null
  }

  handleBeforeSendHeaders(details: Electron.OnBeforeSendHeadersListenerDetails): void {
    this.remember(details.id, details.requestHeaders)
  }

  handleHeadersReceived(details: OnHeadersReceivedListenerDetails): void {
    try {
      this.inspect(details)
    } catch (e) {
      dlog(`threw ${errorMessage(e)} ${details.url.slice(0, 300)}`)
    }
  }

  private remember(id: number, headers: Record<string, string>): void {
    const kept: Record<string, string> = {}
    for (const [k, v] of Object.entries(headers)) {
      if (KEEP_REQUEST_HEADERS.includes(k.toLowerCase())) kept[k] = v
    }
    this.reqHeaders.set(id, kept)
    this.reqOrder.push(id)
    while (this.reqOrder.length > 800) {
      const old = this.reqOrder.shift()
      if (old !== undefined) this.reqHeaders.delete(old)
    }
  }

  private inspect(details: OnHeadersReceivedListenerDetails): void {
    const h = lowerHeaders(details.responseHeaders)
    const ct = h['content-type'] ?? ''
    const mediaLike = ct.startsWith('video/') || ct.startsWith('audio/') || ct.includes('mpegurl') || ct.includes('dash+xml') || ct.includes('octet-stream')
    const interesting = DEBUG && (details.resourceType === 'media' || mediaLike)
    const trace = (why: string): void => {
      if (interesting) dlog(`${why} status=${details.statusCode} type=${details.resourceType} wc=${details.webContentsId} frame=${details.frame?.url?.slice(0, 80) ?? '-'} ct=${ct} cl=${h['content-length'] ?? '-'} cr=${h['content-range'] ?? '-'} cd=${h['content-disposition'] ?? '-'} ${details.url.slice(0, 300)}`)
    }
    if (details.statusCode >= 300 && details.statusCode !== 304) return trace('skip:status')
    if (details.method !== 'GET') return trace('skip:method')
    const tabId = details.webContentsId ?? -1
    if (tabId < 0 || !this.isTab(tabId)) return trace('skip:not-tab')
    const c = classify(details.url, ct, totalSize(h), h['content-disposition'], { resourceType: details.resourceType })
    if (!c) return trace('skip:classify')
    if (c.kind === 'file' && c.size !== null && c.size < getSettings().detectMinSize) return trace('skip:small')
    trace(`ok:${c.kind}`)

    const seen = this.seen.get(tabId) ?? new Set<string>()
    this.seen.set(tabId, seen)
    if (seen.has(details.url)) {
      const existing = this.byTab.get(tabId)?.find((x) => x.url === details.url)
      if (existing) {
        let changed = false
        if (existing.size === null && c.size !== null) {
          existing.size = c.size
          changed = true
        }
        if (existing.found === 'scan') {
          // 스캔으로 먼저 찾은 항목이 실제로 요청되면 정확한 정보로 갱신
          existing.found = 'network'
          existing.mime = c.mime
          existing.kind = c.kind
          if (c.filename) existing.filename = c.filename
          if (existing.size !== null && existing.probe?.status !== 'ok') existing.probe = { status: 'ok', httpStatus: details.statusCode }
          changed = true
        }
        if (changed) {
          this.emit('updated', existing)
          this.emit('changed', tabId)
          if (this.needsProbe(existing)) this.prober.enqueue(existing)
        }
      }
      return
    }
    seen.add(details.url)

    const wc = webContents.fromId(tabId)
    if (!wc || wc.isDestroyed()) return
    const pageUrl = wc.getURL()
    const pageTitle = wc.getTitle()
    const reqH = this.reqHeaders.get(details.id) ?? {}
    const headers: Record<string, string> = {}
    for (const [k, v] of Object.entries(reqH)) headers[canonicalKey(k)] = v
    if (!headers.Referer) headers.Referer = details.referrer || pageUrl
    if (!headers['User-Agent']) headers['User-Agent'] = wc.session.getUserAgent()

    const item: DetectedMedia = {
      id: newId(),
      tabId,
      url: details.url,
      kind: c.kind,
      mime: c.mime,
      size: c.size,
      filename: c.filename,
      pageUrl,
      pageTitle,
      headers,
      detectedAt: Date.now(),
      found: 'network'
    }
    this.pushItem(item, wc.session)
  }

  private pushItem(item: DetectedMedia, session: Session): void {
    const finish = (): void => {
      const list = this.byTab.get(item.tabId) ?? []
      this.byTab.set(item.tabId, list)
      list.push(item)
      if (list.length > MAX_PER_TAB) list.splice(0, list.length - MAX_PER_TAB)
      this.emit('detected', item)
      this.emit('changed', item.tabId)
      if (this.needsProbe(item)) this.prober.enqueue(item)
    }
    if (item.headers.Cookie) finish()
    else
      cookieHeaderFor(session, item.url)
        .then((ck) => {
          if (ck) item.headers.Cookie = ck
        })
        .finally(finish)
  }

  /** 페이지 스캔 preload 가 찾은 후보를 감지 목록에 합친다. */
  addScanned(tabId: number, payload: ScanPayload): void {
    if (!this.isTab(tabId) || !payload || !Array.isArray(payload.items)) return
    const wc = webContents.fromId(tabId)
    if (!wc || wc.isDestroyed()) return
    const seen = this.seen.get(tabId) ?? new Set<string>()
    this.seen.set(tabId, seen)
    const pageUrl = typeof payload.pageUrl === 'string' ? payload.pageUrl : wc.getURL()
    const pageTitle = wc.getTitle() || (typeof payload.title === 'string' ? payload.title : '')
    let added = 0
    for (const raw of payload.items.slice(0, 50)) {
      if (!raw || typeof raw.url !== 'string' || !/^https?:\/\//i.test(raw.url)) continue
      if (!['file', 'hls', 'dash', 'page'].includes(raw.kind)) continue
      if (seen.has(raw.url)) continue
      if (seen.size >= MAX_PER_TAB) break
      seen.add(raw.url)
      const ext = extOfUrl(raw.url)
      const item: DetectedMedia = {
        id: newId(),
        tabId,
        url: raw.url,
        kind: raw.kind,
        mime: raw.kind === 'hls' ? 'application/vnd.apple.mpegurl' : raw.kind === 'dash' ? 'application/dash+xml' : raw.kind === 'page' ? 'text/html' : mimeFromExt(ext || 'mp4'),
        size: null,
        filename: raw.kind !== 'page' && isMediaExt(ext) ? basenameOfUrl(raw.url) : null,
        pageUrl,
        pageTitle,
        headers: { Referer: pageUrl, 'User-Agent': wc.session.getUserAgent() },
        detectedAt: Date.now(),
        found: 'scan',
        source: typeof raw.source === 'string' ? raw.source.slice(0, 20) : undefined,
        poster: typeof raw.poster === 'string' && /^https?:\/\//i.test(raw.poster) ? raw.poster : undefined
      }
      this.pushItem(item, wc.session)
      added++
    }
    if (added) this.emit('changed', tabId)
  }

  getDetected(tabId?: number): DetectedMedia[] {
    if (tabId !== undefined) return [...(this.byTab.get(tabId) ?? [])]
    return [...this.byTab.values()].flat()
  }

  countFor(tabId: number): number {
    return this.byTab.get(tabId)?.length ?? 0
  }

  clearTab(tabId: number): void {
    const had = (this.byTab.get(tabId)?.length ?? 0) > 0
    this.byTab.delete(tabId)
    this.seen.delete(tabId)
    if (had) this.emit('changed', tabId)
  }

  removeTab(tabId: number): void {
    this.byTab.delete(tabId)
    this.seen.delete(tabId)
  }
}

function canonicalKey(k: string): string {
  return k
    .toLowerCase()
    .split('-')
    .map((s) => (s ? s[0].toUpperCase() + s.slice(1) : s))
    .join('-')
}
