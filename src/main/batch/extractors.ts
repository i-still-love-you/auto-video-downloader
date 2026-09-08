// 영상 페이지 HTML 에서 실제 미디어 주소를 찾아내는 추출기.
// 1) KVS(Kernel Video Sharing) 계열: 플레이어 설정(flashvars)의 video_url / video_alt_url* 를 읽는다.
//    base64 로 감싼 주소와 license_code 로 섞은(function/0/) 주소를 모두 푼다.
// 2) 일반: og:video, video/source 태그, JSON-LD contentUrl, 인라인 스크립트의 m3u8/mp4 주소.
import type { PreferredQuality } from '@shared/types'

export interface MediaCandidate {
  url: string
  label?: string
  height?: number
  /** 화질 정보가 없을 때 쓰는 순서 (클수록 고화질로 가정) */
  rank: number
}

export interface PageMedia {
  source: 'kvs' | 'generic'
  title?: string
  thumbnail?: string
  candidates: MediaCandidate[]
}

// ---------- 공통 ----------

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
}

function unescapeJs(s: string): string {
  return s
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\\//g, '/')
    .replace(/\\n/g, '\n')
    .replace(/\\(['"\\])/g, '$1')
}

function absolute(raw: string, base: string): string | null {
  let u = raw.trim()
  if (!u) return null
  if (u.startsWith('//')) u = `https:${u}`
  try {
    const abs = new URL(u, base)
    if (abs.protocol !== 'http:' && abs.protocol !== 'https:') return null
    return abs.href
  } catch {
    return null
  }
}

export function heightFrom(text: string | undefined): number | undefined {
  if (!text) return undefined
  let m = /(\d{3,4})p\b/i.exec(text)
  if (m) return Number(m[1])
  m = /\b\d{3,4}x(\d{3,4})\b/i.exec(text)
  if (m) return Number(m[1])
  m = /[_\-/](\d{3,4})\.(?:mp4|m3u8|webm)/i.exec(text)
  if (m && Number(m[1]) >= 144 && Number(m[1]) <= 4320) return Number(m[1])
  if (/\b4k\b|2160/i.test(text)) return 2160
  if (/\bhd\b/i.test(text)) return 720
  if (/\bsd\b/i.test(text)) return 480
  return undefined
}

function metaContent(html: string, attr: 'property' | 'name', key: string): string | undefined {
  const re = new RegExp(`<meta[^>]+${attr}=["']${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'][^>]*>`, 'i')
  const tag = re.exec(html)?.[0]
  if (!tag) return undefined
  const c = /content=["']([^"']*)["']/i.exec(tag)
  return c ? decodeEntities(c[1]) : undefined
}

export function titleFromHtml(html: string): string | undefined {
  const og = metaContent(html, 'property', 'og:title')
  if (og?.trim()) return og.trim()
  const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html)
  if (h1) {
    const t = decodeEntities(h1[1].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()
    if (t) return t
  }
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)
  if (title) {
    const t = decodeEntities(title[1]).replace(/\s+/g, ' ').trim()
    if (t) return t
  }
  return undefined
}

function thumbnailFromHtml(html: string, base: string): string | undefined {
  const og = metaContent(html, 'property', 'og:image')
  if (og) return absolute(og, base) ?? undefined
  const poster = /<video[^>]+poster=["']([^"']+)["']/i.exec(html)
  if (poster) return absolute(decodeEntities(poster[1]), base) ?? undefined
  return undefined
}

// ---------- KVS ----------

/** `var flashvars = { key: 'value', ... }` 를 키/값으로 읽는다. 문자열 안의 중괄호는 무시한다. */
export function parseFlashvars(html: string): Record<string, string> | null {
  const m = /(?:var|let|const)\s+flashvars\s*=\s*\{/.exec(html) ?? /\bflashvars\s*=\s*\{/.exec(html)
  if (!m) return null
  const start = m.index + m[0].length
  let i = start
  let depth = 1
  let quote: string | null = null
  const limit = Math.min(html.length, start + 300_000)
  for (; i < limit; i++) {
    const c = html[i]
    if (quote) {
      if (c === '\\') i++
      else if (c === quote) quote = null
      continue
    }
    if (c === "'" || c === '"') quote = c
    else if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) break
    }
  }
  const body = html.slice(start, i)
  const out: Record<string, string> = {}
  const re = /(?:^|[,{\s])['"]?([A-Za-z_][\w]*)['"]?\s*:\s*(?:'((?:\\.|[^'\\])*)'|"((?:\\.|[^"\\])*)")/g
  let mm: RegExpExecArray | null
  while ((mm = re.exec(body))) out[mm[1]] = unescapeJs(mm[2] ?? mm[3] ?? '')
  return Object.keys(out).length ? out : null
}

/** base64 로 감싼 주소면 푼다. 이미 주소 형태면 그대로. */
export function maybeBase64Url(v: string): string {
  const s = v.trim()
  if (/^(https?:)?\/\//i.test(s) || s.startsWith('function/') || s.startsWith('/')) return s
  if (s.length < 12 || !/^[A-Za-z0-9+/]+={0,2}$/.test(s)) return s
  try {
    const d = Buffer.from(s, 'base64').toString('utf8')
    if (/^(https?:\/\/|\/\/|function\/|\/)/i.test(d) && !/[\x00-\x08\x0e-\x1f]/.test(d)) return d
  } catch {
    /* ignore */
  }
  return s
}

/** yt-dlp 의 _kvs_get_license_token 이식 */
export function kvsLicenseToken(license: string): number[] {
  const code = license.replace(/\$/g, '')
  if (!/^\d+$/.test(code) || code.length < 2) return []
  const values = [...code].map(Number)
  const mod = code.replace(/0/g, '1')
  const center = Math.floor(mod.length / 2)
  const front = Number(mod.slice(0, center + 1))
  const back = Number(mod.slice(center))
  const modl = String(4 * Math.abs(front - back)).slice(0, center + 1)
  const out: number[] = []
  for (let index = 0; index < modl.length; index++) {
    const current = Number(modl[index])
    for (let offset = 0; offset < 4; offset++) out.push(((values[index + offset] ?? 0) + current) % 10)
  }
  return out
}

/** yt-dlp 의 _kvs_get_real_url 이식: `function/0/` 로 시작하는 주소의 해시를 license_code 로 되돌린다. */
export function kvsRealUrl(videoUrl: string, license?: string): string {
  const prefix = 'function/0/'
  if (!videoUrl.startsWith(prefix)) return videoUrl
  const raw = videoUrl.slice(prefix.length)
  if (!license) return raw
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return raw
  }
  const parts = u.pathname.split('/')
  const HASH = 32
  if (parts.length < 4 || parts[3].length < HASH) return raw
  const hash = parts[3].slice(0, HASH)
  const token = kvsLicenseToken(license)
  if (!token.length) return raw
  const idx = Array.from({ length: HASH }, (_, i) => i)
  let accum = 0
  for (let src = HASH - 1; src >= 0; src--) {
    accum += token[src] ?? 0
    const dest = (src + accum) % HASH
    const tmp = idx[src]
    idx[src] = idx[dest]
    idx[dest] = tmp
  }
  parts[3] = idx.map((i) => hash[i]).join('') + parts[3].slice(HASH)
  u.pathname = parts.join('/')
  return u.href
}

export function extractKvs(html: string, pageUrl: string): PageMedia | null {
  const fv = parseFlashvars(html)
  if (!fv) return null
  const license = fv.license_code
  const cands: MediaCandidate[] = []
  for (const [key, value] of Object.entries(fv)) {
    const m = /^video_(?:(alt)_)?url(\d*)$/.exec(key) ?? (key === 'video_url_hd' ? ['video_url_hd', 'hd', ''] : null)
    if (!m) continue
    const v = value.trim()
    // '1' / 'MQ==' 은 "없음" 표시
    if (!v || v === '1' || v === 'MQ==' || v === '0') continue
    let url = maybeBase64Url(v)
    url = kvsRealUrl(url, license)
    const abs = absolute(url, pageUrl)
    if (!abs) continue
    const label = fv[`${key}_text`]
    const n = Number(m[2] || '0')
    const rank = key === 'video_url' ? 0 : key === 'video_url_hd' ? 5 : 10 + (n || 1)
    cands.push({ url: abs, label, height: heightFrom(label) ?? heightFrom(abs), rank })
  }
  if (!cands.length) return null
  const title = fv.video_title?.trim() || titleFromHtml(html)
  const thumbRaw = fv.preview_url || fv.preview_url1 || fv.poster
  const thumbnail = (thumbRaw ? absolute(thumbRaw, pageUrl) : null) ?? thumbnailFromHtml(html, pageUrl)
  return { source: 'kvs', title, thumbnail, candidates: dedupe(cands) }
}

// ---------- 일반 페이지 ----------

const MEDIA_URL_RE = /(?:https?:)?\\?\/\\?\/[^\s"'<>()\\]+?\.(?:m3u8|mpd|mp4|m4v|webm|mov|mkv)(?:\?[^\s"'<>()\\]*)?/gi
const MEDIA_EXT_RE = /\.(m3u8|mpd|mp4|m4v|webm|mov|mkv)(?=$|[?#])/i

function attrOf(tag: string, name: string): string | undefined {
  const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag)
  return m ? decodeEntities(m[1] ?? m[2] ?? m[3] ?? '') : undefined
}

export function extractGeneric(html: string, pageUrl: string): PageMedia | null {
  const cands: MediaCandidate[] = []
  let rank = 100
  const push = (raw: string | undefined, label?: string): void => {
    if (!raw) return
    const abs = absolute(unescapeJs(raw), pageUrl)
    if (!abs || abs === pageUrl) return
    if (!MEDIA_EXT_RE.test(new URL(abs).pathname) && !/[?&](?:format|ext)=(?:mp4|m3u8)/i.test(abs)) return
    cands.push({ url: abs, label, height: heightFrom(label) ?? heightFrom(abs), rank: rank-- })
  }
  for (const key of ['og:video:secure_url', 'og:video:url', 'og:video']) push(metaContent(html, 'property', key))
  push(metaContent(html, 'name', 'twitter:player:stream'))
  for (const tag of html.match(/<(?:video|source|audio)\b[^>]*>/gi) ?? []) {
    const src = attrOf(tag, 'src') ?? attrOf(tag, 'data-src')
    const label = attrOf(tag, 'label') ?? attrOf(tag, 'size') ?? attrOf(tag, 'res') ?? attrOf(tag, 'title')
    push(src, label)
  }
  for (const m of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    for (const c of m[1].matchAll(/"contentUrl"\s*:\s*"([^"]+)"/g)) push(c[1])
  }
  // 인라인 스크립트 (플레이어 설정 JSON 등). 3MB 까지만 본다.
  let budget = 3_000_000
  for (const m of html.matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)) {
    const raw = m[1]
    if (!raw || raw.length > budget) continue
    budget -= raw.length
    const t = raw.replace(/\\\//g, '/').replace(/\\u002[fF]/g, '/')
    for (const u of t.matchAll(MEDIA_URL_RE)) push(u[0])
  }
  if (!cands.length) return null
  return { source: 'generic', title: titleFromHtml(html), thumbnail: thumbnailFromHtml(html, pageUrl), candidates: dedupe(cands) }
}

function dedupe(cands: MediaCandidate[]): MediaCandidate[] {
  const seen = new Set<string>()
  const out: MediaCandidate[] = []
  for (const c of cands) {
    if (seen.has(c.url)) continue
    seen.add(c.url)
    out.push(c)
  }
  return out
}

/** KVS 를 먼저 시도하고, 없으면 일반 추출 */
export function extractPageMedia(html: string, pageUrl: string): PageMedia | null {
  return extractKvs(html, pageUrl) ?? extractGeneric(html, pageUrl)
}

/** 선호 화질에 맞는 후보 하나를 고른다. 높이를 모르는 후보는 순서(rank)로 고화질 여부를 가늠한다. */
export function pickCandidate(cands: MediaCandidate[], pref: PreferredQuality): MediaCandidate {
  if (!cands.length) throw new Error('다운로드할 수 있는 주소가 없습니다')
  const known = cands.filter((c) => c.height !== undefined)
  const sorted = [...cands].sort((a, b) => (b.height ?? -1) - (a.height ?? -1) || b.rank - a.rank)
  if (pref === 'worst') {
    if (known.length) return [...known].sort((a, b) => a.height! - b.height! || a.rank - b.rank)[0]
    return [...cands].sort((a, b) => a.rank - b.rank)[0]
  }
  if (pref === 'best' || pref === 'ask') return sorted[0]
  const limit = Number(pref)
  return sorted.find((c) => c.height !== undefined && c.height <= limit) ?? sorted.find((c) => c.height === undefined) ?? sorted[sorted.length - 1]
}
