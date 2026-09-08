import { EventEmitter } from 'node:events'
import path from 'node:path'
import { webContents, type OnHeadersReceivedListenerDetails, type Session } from 'electron'
import type { DetectedMedia, MediaKind } from '@shared/types'
import { basenameOfUrl, extOfUrl, isMediaExt, mimeFromExt, newId, parseContentDisposition } from '../util'
import { cookieHeaderFor } from '../downloads/net'
import { getSettings } from '../settings'

const SKIP_EXT = new Set([
  'ts', 'm4s', 'm4f', 'vtt', 'srt', 'key', 'jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'ico', 'js', 'css', 'html',
  'htm', 'json', 'xml', 'txt', 'woff', 'woff2', 'ttf', 'map'
])
const SEGMENT_PATTERN =
  /(?:^|[/_\-.])(?:seg(?:ment)?|chunk|frag(?:ment)?|piece)[-_]?\d+|[-_]\d{2,}\.(?:m4s|mp4)$|\/init(?:-[\w]+)?\.mp4$|\/\d+\.m4s$/i
const MAX_PER_TAB = 200

export interface Classified {
  kind: MediaKind
  mime: string
  size: number | null
  filename: string | null
}

/** 응답 헤더와 URL만 보고 미디어 여부를 판별한다. */
export function classify(url: string, mime: string, size: number | null, disposition?: string): Classified | null {
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
  if (SEGMENT_PATTERN.test(pathname)) return null

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
 * 브라우저 세션의 네트워크 응답을 감시해 동영상 소스를 찾아낸다.
 * 이벤트: 'detected' (DetectedMedia), 'changed' (tabId)
 */
export class Sniffer extends EventEmitter {
  private byTab = new Map<number, DetectedMedia[]>()
  private seen = new Map<number, Set<string>>()
  private reqHeaders = new Map<number, Record<string, string>>()
  private reqOrder: number[] = []

  constructor(
    private readonly session: Session,
    private readonly isTab: (id: number) => boolean
  ) {
    super()
    this.attach()
  }

  private attach(): void {
    const filter = { urls: ['http://*/*', 'https://*/*'] }
    this.session.webRequest.onBeforeSendHeaders(filter, (details, callback) => {
      this.remember(details.id, details.requestHeaders)
      callback({ requestHeaders: details.requestHeaders })
    })
    this.session.webRequest.onHeadersReceived(filter, (details, callback) => {
      callback({ responseHeaders: details.responseHeaders })
      try {
        this.inspect(details)
      } catch {
        /* 감지 실패는 무시 */
      }
    })
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
    if (details.statusCode >= 300 && details.statusCode !== 304) return
    if (details.method !== 'GET') return
    const tabId = details.webContentsId ?? -1
    if (tabId < 0 || !this.isTab(tabId)) return
    const h = lowerHeaders(details.responseHeaders)
    const c = classify(details.url, h['content-type'] ?? '', totalSize(h), h['content-disposition'])
    if (!c) return
    if (c.kind === 'file' && c.size !== null && c.size < getSettings().detectMinSize) return

    const seen = this.seen.get(tabId) ?? new Set<string>()
    this.seen.set(tabId, seen)
    if (seen.has(details.url)) {
      const existing = this.byTab.get(tabId)?.find((x) => x.url === details.url)
      if (existing && existing.size === null && c.size !== null) {
        existing.size = c.size
        this.emit('changed', tabId)
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
    if (!headers['User-Agent']) headers['User-Agent'] = this.session.getUserAgent()

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
      detectedAt: Date.now()
    }

    const finish = (): void => {
      const list = this.byTab.get(tabId) ?? []
      this.byTab.set(tabId, list)
      list.push(item)
      if (list.length > MAX_PER_TAB) list.splice(0, list.length - MAX_PER_TAB)
      this.emit('detected', item)
      this.emit('changed', tabId)
    }

    if (headers.Cookie) finish()
    else
      cookieHeaderFor(this.session, details.url)
        .then((ck) => {
          if (ck) item.headers.Cookie = ck
        })
        .finally(finish)
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
