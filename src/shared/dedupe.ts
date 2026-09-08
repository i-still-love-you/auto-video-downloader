// 다운로드 이력과 중복 판정. 메인 프로세스(이력 저장·자동 다운로드)와 렌더러(배지·경고)가 같은 규칙을 쓴다.
// 순수 함수만 두고 Node/DOM API 는 쓰지 않는다.

export interface DownloadRecord {
  id: string
  title: string
  host: string
  /** 영상 페이지 주소와 그 정규화 키 (페이지 없이 주소만으로 받은 경우 비어 있음) */
  pageUrl?: string
  pageKey?: string
  /** 실제로 받은 소스 주소와 휘발성 쿼리(토큰·난수 등)를 뺀 정규화 키 */
  sourceUrl: string
  sourceKey: string
  engine: 'http' | 'hls' | 'ytdlp'
  size: number | null
  /** 길이(초). 완료 후 ffprobe 로 읽거나 분석 결과에서 가져온다 */
  duration: number | null
  resolution?: string
  filePath: string
  thumbnail?: string
  downloadedAt: number
  /** 목록을 조회한 시점에 파일이 그 자리에 있었는지 (저장하지 않고 조회 때마다 채움) */
  exists?: boolean
}

export interface DuplicateQuery {
  pageUrl?: string
  url?: string
  size?: number | null
  duration?: number | null
  title?: string
  host?: string
}

/** certain = 같은 페이지 또는 같은 소스 주소, likely = 크기·길이·제목이 같아 같은 영상으로 보임 */
export type DuplicateLevel = 'certain' | 'likely'

export interface DuplicateMatch {
  record: DownloadRecord
  level: DuplicateLevel
  reason: string
}

/** 방문·요청마다 값이 바뀌는 쿼리 이름. 이 키들은 소스 주소 비교에서 뺀다. */
const VOLATILE_PARAMS = new Set([
  'token', 'v-acctoken', 'acctoken', 'access_token', 'rnd', 'rand', 'random', 'expires', 'expire', 'exp', 'e', 'st', 'sig', 'signature',
  'hash', 'key', 'ts', 't', 'time', '_', 'ip', 'hmac', 'auth', 'session', 'sessionid', 'nonce', 'validfrom', 'validto', 'hdnts',
  'policy', 'key-pair-id', 'verify', 'vkey', 'secure', 'md5', 'ttl', 'ctime', 'stime', 'etime', 'timestamp', 'sign', 'sn', 'cid'
])
/** 추적용 쿼리 이름. 페이지 주소 비교에서 뺀다. */
const TRACKING_PARAMS = /^(utm_|fbclid$|gclid$|ref$|referrer$|source$|_ga$|mc_)/i

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    return ''
  }
}

function rebuild(u: URL, keep: (k: string) => boolean): string {
  const pairs: Array<[string, string]> = []
  for (const [k, v] of u.searchParams) if (keep(k)) pairs.push([k, v])
  pairs.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]))
  const host = u.hostname.toLowerCase().replace(/^www\./, '')
  const port = u.port ? `:${u.port}` : ''
  const path = u.pathname.replace(/\/+$/, '') || '/'
  const query = pairs.length ? `?${pairs.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')}` : ''
  return `${host}${port}${path}${query}`
}

/** 소스 주소 키: 프로토콜·www·해시·휘발성 쿼리·끝 슬래시를 뺀다 */
export function sourceKeyOf(url: string): string {
  try {
    const u = new URL(url)
    return rebuild(u, (k) => !VOLATILE_PARAMS.has(k.toLowerCase()) && !/^(x-amz-|x-goog-|cf_|cf-|aws)/i.test(k))
  } catch {
    return url.trim()
  }
}

/** 페이지 주소 키: 프로토콜·www·해시·추적 쿼리·끝 슬래시를 뺀다. 사이트 첫 페이지는 영상을 특정하지 못하므로 빈 값. */
export function pageKeyOf(url: string): string {
  try {
    const u = new URL(url)
    if (!u.pathname.replace(/\/+$/, '') && !u.search) return ''
    return rebuild(u, (k) => !TRACKING_PARAMS.test(k))
  } catch {
    return ''
  }
}

export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/\.(mp4|mkv|webm|m4v|mov|ts|avi|flv)$/i, '')
    .replace(/\s*\(\d+\)$/, '')
    .replace(/[\s\-_–—·•.,:;!?'"`´()[\]{}【】「」『』〈〉《》#*/\\|+~]+/g, ' ')
    .trim()
}

/** 이력에서 중복 후보를 찾는다. certain 이 앞에, 같은 등급 안에서는 최근 것이 앞에 온다. */
export function findDuplicates(records: DownloadRecord[], q: DuplicateQuery): DuplicateMatch[] {
  const out: DuplicateMatch[] = []
  const pk = q.pageUrl ? pageKeyOf(q.pageUrl) : ''
  const sk = q.url ? sourceKeyOf(q.url) : ''
  const host = q.host || (q.pageUrl ? hostOf(q.pageUrl) : '') || (q.url ? hostOf(q.url) : '')
  const nt = q.title ? normalizeTitle(q.title) : ''
  const size = q.size != null && q.size > 0 ? q.size : null
  const dur = q.duration != null && q.duration > 0 ? q.duration : null
  for (const r of records) {
    if (pk && r.pageKey && r.pageKey === pk) {
      out.push({ record: r, level: 'certain', reason: '같은 영상 페이지' })
      continue
    }
    if (sk && r.sourceKey && r.sourceKey === sk) {
      out.push({ record: r, level: 'certain', reason: '같은 소스 주소' })
      continue
    }
    const sizeEq = size !== null && r.size !== null && r.size === size
    const durKnown = dur !== null && r.duration !== null && r.duration > 0
    const durEq = durKnown && Math.abs(dur! - r.duration!) <= 1.5
    // 크기가 같아도 길이가 확실히 다르면 다른 영상
    if (sizeEq && durKnown && !durEq) continue
    if (sizeEq && durEq) {
      out.push({ record: r, level: 'likely', reason: '크기와 길이가 같음' })
      continue
    }
    if (sizeEq && size! >= 1_000_000) {
      out.push({ record: r, level: 'likely', reason: '크기가 같음' })
      continue
    }
    if (host && r.host === host && nt.length >= 6 && r.title && normalizeTitle(r.title) === nt) {
      if (durKnown && !durEq) continue
      out.push({ record: r, level: 'likely', reason: '같은 사이트의 같은 제목' })
    }
  }
  return out.sort((a, b) => (a.level === b.level ? b.record.downloadedAt - a.record.downloadedAt : a.level === 'certain' ? -1 : 1))
}

export function bestDuplicate(records: DownloadRecord[], q: DuplicateQuery): DuplicateMatch | undefined {
  return findDuplicates(records, q)[0]
}

/** 목록 페이지에 표시된 "1:23:45" 같은 길이 문자열을 초로 */
export function parseDurationText(text: string | undefined): number | null {
  if (!text) return null
  const m = /^\s*(?:(\d{1,3}):)?(\d{1,2}):(\d{2})\s*$/.exec(text)
  if (!m) return null
  return (m[1] ? Number(m[1]) * 3600 : 0) + Number(m[2]) * 60 + Number(m[3])
}
