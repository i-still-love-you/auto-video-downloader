/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
// 브라우저 탭(모든 프레임)에 주입되는 페이지 스캔 스크립트.
// 재생 전에 DOM·메타 태그·JSON-LD·인라인 스크립트에서 동영상 주소를 찾아 메인 프로세스로 보낸다.
import { ipcRenderer } from 'electron'
import type { MediaKind, PageScanSettings, ScanItem, ScanPayload } from '@shared/types'

// sandbox preload 는 다른 파일을 require 할 수 없으므로 공용 모듈을 import 하지 않고 채널 이름을 직접 쓴다 (src/shared/ipc.ts 의 IPC.scan 과 동일)
const CH_FOUND = 'scan:found'
const CH_CONFIG = 'scan:config'

const MEDIA_EXT = /\.(m3u8|mpd|mp4|m4v|webm|mov|mkv|flv|avi|wmv|3gp|ogv|mp3|m4a)(?=$|[?#])/i
const URL_RE = /(?:https?:)?\\?\/\\?\/[^\s"'<>()\\]+?\.(?:m3u8|mpd|mp4|m4v|webm|mov|mkv)(?:\?[^\s"'<>()\\]*)?/gi
const EMBED_HOSTS = [
  /(^|\.)youtube(-nocookie)?\.com$/,
  /(^|\.)youtu\.be$/,
  /(^|\.)vimeo\.com$/,
  /(^|\.)dailymotion\.com$/,
  /(^|\.)streamable\.com$/,
  /(^|\.)twitch\.tv$/,
  /(^|\.)tv\.naver\.com$/,
  /(^|\.)tv\.kakao\.com$/,
  /(^|\.)facebook\.com$/,
  /(^|\.)ok\.ru$/,
  /(^|\.)rumble\.com$/,
  /(^|\.)bitchute\.com$/,
  /(^|\.)vk\.com$/
]
const MAX_ITEMS = 50
const SCRIPT_BUDGET = 3_000_000

let config: PageScanSettings = { enabled: true, autoLoadMetadata: true }
const sent = new Set<string>()
const loaded = new WeakSet<HTMLMediaElement>()
let timer: number | undefined

function kindOf(url: string): MediaKind | null {
  let pathname = url
  try {
    pathname = new URL(url).pathname
  } catch {
    /* 그대로 */
  }
  const m = /\.([a-z0-9]{1,5})$/i.exec(pathname)
  const ext = m ? m[1].toLowerCase() : ''
  if (ext === 'm3u8') return 'hls'
  if (ext === 'mpd') return 'dash'
  if (MEDIA_EXT.test(`.${ext}`)) return 'file'
  return null
}

function isEmbedHost(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase()
    return EMBED_HOSTS.some((re) => re.test(host))
  } catch {
    return false
  }
}

function normalize(raw: string | null | undefined): string | null {
  if (!raw) return null
  let u = raw.replace(/\\\//g, '/').replace(/&amp;/g, '&').trim()
  if (!u || u.startsWith('blob:') || u.startsWith('data:') || u.startsWith('javascript:')) return null
  if (u.startsWith('//')) u = `${location.protocol === 'file:' ? 'https:' : location.protocol}${u}`
  try {
    const abs = new URL(u, location.href)
    if (abs.protocol !== 'http:' && abs.protocol !== 'https:') return null
    if (abs.href.length > 2000) return null
    return abs.href
  } catch {
    return null
  }
}

function maybeLoadMetadata(m: HTMLMediaElement): void {
  if (!config.autoLoadMetadata || loaded.has(m) || m.readyState > 0) return
  const src = m.currentSrc || m.src || m.querySelector('source[src]')?.getAttribute('src') || ''
  if (!src || src.startsWith('blob:') || src.startsWith('data:')) return
  loaded.add(m)
  try {
    if (m.preload === 'none') m.preload = 'metadata'
    m.load()
  } catch {
    /* ignore */
  }
}

function walkJsonLd(node: unknown, depth: number, push: (raw: string, source: string, kind?: MediaKind, poster?: string) => void): void {
  if (!node || depth > 6) return
  if (Array.isArray(node)) {
    for (const n of node) walkJsonLd(n, depth + 1, push)
    return
  }
  if (typeof node !== 'object') return
  const obj = node as Record<string, unknown>
  if (typeof obj.contentUrl === 'string') {
    const thumb = typeof obj.thumbnailUrl === 'string' ? obj.thumbnailUrl : Array.isArray(obj.thumbnailUrl) && typeof obj.thumbnailUrl[0] === 'string' ? obj.thumbnailUrl[0] : undefined
    push(obj.contentUrl, 'jsonld', kindOf(obj.contentUrl) ?? 'file', thumb)
  }
  if (typeof obj.embedUrl === 'string' && isEmbedHost(obj.embedUrl)) push(obj.embedUrl, 'jsonld', 'page')
  for (const v of Object.values(obj)) if (v && typeof v === 'object') walkJsonLd(v, depth + 1, push)
}

function collect(): ScanItem[] {
  const out: ScanItem[] = []
  const push = (raw: string, source: string, kind?: MediaKind, poster?: string): void => {
    if (out.length >= MAX_ITEMS) return
    const url = normalize(raw)
    if (!url || url === location.href || sent.has(url)) return
    const k = kind ?? kindOf(url)
    if (!k) return
    sent.add(url)
    out.push({ url, kind: k, source, poster: poster ? (normalize(poster) ?? undefined) : undefined })
  }

  // <video>/<audio>/<source>
  for (const el of Array.from(document.querySelectorAll('video, audio'))) {
    const m = el as HTMLMediaElement
    const poster = m instanceof HTMLVideoElement ? m.poster : undefined
    for (const raw of [m.currentSrc, m.getAttribute('src'), m.getAttribute('data-src')]) if (raw) push(raw, 'video', kindOf(raw) ?? 'file', poster)
    for (const s of Array.from(m.querySelectorAll('source'))) {
      const raw = s.getAttribute('src') || s.getAttribute('data-src')
      if (raw) push(raw, 'video', kindOf(raw) ?? 'file', poster)
    }
    maybeLoadMetadata(m)
  }

  // 메타 태그
  for (const sel of ['meta[property="og:video"]', 'meta[property="og:video:url"]', 'meta[property="og:video:secure_url"]', 'meta[name="twitter:player:stream"]']) {
    for (const m of Array.from(document.querySelectorAll(sel))) {
      const c = m.getAttribute('content')
      if (!c) continue
      const k = kindOf(c)
      if (k) push(c, 'meta', k)
      else if (isEmbedHost(c)) push(c, 'meta', 'page')
    }
  }

  // JSON-LD
  for (const s of Array.from(document.querySelectorAll('script[type="application/ld+json"]'))) {
    try {
      walkJsonLd(JSON.parse(s.textContent || 'null'), 0, push)
    } catch {
      /* ignore */
    }
  }

  // 미디어 파일 링크, 임베드 iframe
  for (const a of Array.from(document.querySelectorAll('a[href]'))) {
    const h = a.getAttribute('href')
    if (h && MEDIA_EXT.test(h)) push(h, 'link')
  }
  for (const f of Array.from(document.querySelectorAll('iframe[src]'))) {
    const src = normalize(f.getAttribute('src'))
    if (src && isEmbedHost(src)) push(src, 'iframe', 'page')
  }

  // data-* 속성
  for (const el of Array.from(document.querySelectorAll('[data-src],[data-url],[data-video],[data-video-url],[data-file],[data-hls],[data-mp4],[data-stream],[data-source]'))) {
    for (const attr of el.getAttributeNames()) {
      if (!attr.startsWith('data-')) continue
      const v = el.getAttribute(attr)
      if (v && MEDIA_EXT.test(v)) push(v, 'data')
    }
  }

  // 인라인 스크립트 안의 주소 (플레이어 설정 JSON 등)
  let budget = SCRIPT_BUDGET
  for (const s of Array.from(document.querySelectorAll('script:not([src])'))) {
    if (s.getAttribute('type') === 'application/ld+json') continue
    const raw = s.textContent || ''
    if (!raw || raw.length > budget) continue
    budget -= raw.length
    // JSON 문자열의 이스케이프(\/, /)를 풀어 주소가 끊기지 않게 한다
    const t = raw.replace(/\\\//g, '/').replace(/\\u002[fF]/g, '/')
    for (const m of t.matchAll(URL_RE)) push(m[0], 'script')
  }
  return out
}

function report(): void {
  if (!config.enabled) return
  let items: ScanItem[] = []
  try {
    items = collect()
  } catch {
    return
  }
  if (!items.length) return
  const payload: ScanPayload = { pageUrl: location.href, title: document.title, items }
  ipcRenderer.send(CH_FOUND, payload)
}

function schedule(delay: number): void {
  if (timer !== undefined) return
  timer = window.setTimeout(() => {
    timer = undefined
    report()
  }, delay)
}

async function start(): Promise<void> {
  try {
    config = (await ipcRenderer.invoke(CH_CONFIG)) as PageScanSettings
  } catch {
    /* 기본값 사용 */
  }
  if (!config.enabled) return
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => schedule(200))
  else schedule(200)
  window.addEventListener('load', () => schedule(600))

  const observer = new MutationObserver(() => schedule(1000))
  const observe = (): void => {
    if (document.documentElement) {
      observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'data-src', 'href', 'poster'] })
    }
  }
  if (document.documentElement) observe()
  else document.addEventListener('DOMContentLoaded', observe)

  // SPA 주소 변경 감지
  let lastHref = location.href
  window.setInterval(() => {
    if (location.href !== lastHref) {
      lastHref = location.href
      sent.clear()
      schedule(500)
    }
  }, 1000)
}

void start()
