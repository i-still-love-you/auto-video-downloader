// 메인 프로세스와 렌더러가 함께 사용하는 타입 정의

/** page = 임베드/페이지 주소 (yt-dlp 로 분석) */
export type MediaKind = 'file' | 'hls' | 'dash' | 'page'

export interface DetectedMedia {
  id: string
  tabId: number
  url: string
  kind: MediaKind
  mime: string
  size: number | null
  filename: string | null
  pageUrl: string
  pageTitle: string
  headers: Record<string, string>
  detectedAt: number
  /** network = 실제 요청에서 감지, scan = 페이지 DOM/스크립트 스캔에서 발견 */
  found: 'network' | 'scan'
  /** 스캔 출처 (video, meta, jsonld, script, link, iframe, data) */
  source?: string
  poster?: string
  /** 사전 조회 결과: 스캔 항목은 헤더만 받아 크기·형식 확인, HLS 는 재생목록을 읽어 길이·예상 용량 계산 */
  probe?: { status: 'pending' | 'ok' | 'error'; httpStatus?: number; message?: string }
  duration?: number
  estimatedSize?: number
  resolution?: string
  variantCount?: number
  live?: boolean
}

export interface ScanItem {
  url: string
  kind: MediaKind
  source: string
  poster?: string
}

export interface ScanPayload {
  pageUrl: string
  title: string
  items: ScanItem[]
}

export interface PageScanSettings {
  enabled: boolean
  autoLoadMetadata: boolean
}

export interface PrivacySettings {
  /** 새 탭마다 별도 세션(쿠키·저장소 분리). 페이지가 연 팝업과 새 탭 링크는 원래 탭 세션을 물려받는다. */
  isolateTabs: boolean
  /** 팝업/새 탭 링크/복제 탭이 원래 탭의 세션을 물려받을지 여부 */
  inheritOnOpen: boolean
}

export interface TabState {
  id: number
  url: string
  title: string
  favicon: string | null
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  detectedCount: number
  blockedCount: number
}

export interface BrowserState {
  tabs: TabState[]
  activeTabId: number | null
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface HistoryEntry {
  id: string
  url: string
  title: string
  visitedAt: number
}

export interface Bookmark {
  id: string
  url: string
  title: string
  addedAt: number
}

export interface SearchEngine {
  id: string
  name: string
  url: string
}

export type DownloadStatus = 'queued' | 'running' | 'paused' | 'completed' | 'error' | 'canceled'
export type DownloadEngine = 'http' | 'hls' | 'ytdlp'

export interface DownloadProgress {
  downloaded: number
  total: number | null
  speed: number
  eta: number | null
  percent: number | null
  segmentsDone?: number
  segmentsTotal?: number
  stage?: string
}

export interface HlsVariant {
  uri: string
  bandwidth: number
  resolution?: string
  codecs?: string
  frameRate?: number
  audioGroup?: string
  audioUri?: string
  name?: string
}

export interface YtdlpFormat {
  formatId: string
  ext: string
  resolution?: string
  fps?: number
  vcodec?: string
  acodec?: string
  filesize?: number | null
  tbr?: number
  note?: string
  hasVideo: boolean
  hasAudio: boolean
  url?: string
  protocol?: string
}

export interface DownloadTask {
  id: string
  engine: DownloadEngine
  url: string
  title: string
  pageUrl?: string
  headers: Record<string, string>
  cookieFile?: string
  formatId?: string
  variant?: HlsVariant
  outputDir: string
  filename?: string
  filePath?: string
  status: DownloadStatus
  progress: DownloadProgress
  error?: string
  createdAt: number
  startedAt?: number
  completedAt?: number
  thumbnail?: string
  size?: number | null
  mime?: string
}

export interface AnalyzeResult {
  kind: 'file' | 'hls' | 'ytdlp'
  url: string
  title: string
  thumbnail?: string
  duration?: number
  size?: number | null
  mime?: string
  variants?: HlsVariant[]
  formats?: YtdlpFormat[]
  extractor?: string
  headers: Record<string, string>
  cookieFile?: string
  pageUrl?: string
}

export interface EnqueueRequest {
  analyze: AnalyzeResult
  selection?: string
  filename?: string
}

export interface FileEntry {
  name: string
  path: string
  size: number
  mtime: number
  ext: string
  isMedia: boolean
}

export interface VaultItem {
  id: string
  name: string
  size: number
  addedAt: number
  ext: string
  hasThumb?: boolean
}

export interface ThumbnailResult {
  url: string | null
  /** ffmpeg 가 없어 렌더러의 canvas 캡처로 대체할 수 있는 경우 */
  canFallback: boolean
}

export interface ThumbnailCacheInfo {
  count: number
  bytes: number
}

export interface VaultState {
  initialized: boolean
  unlocked: boolean
  items: VaultItem[]
}

export type ToolName = 'ytdlp' | 'ffmpeg'

export interface ToolStatus {
  name: ToolName
  found: boolean
  path?: string
  version?: string
  source?: 'settings' | 'bundled' | 'userData' | 'path'
}

export interface ToolInstallProgress {
  name: ToolName
  stage: 'download' | 'extract' | 'done' | 'error'
  downloaded: number
  total: number | null
  message?: string
}

export interface AdblockSettings {
  enabled: boolean
  lists: string[]
  customRules: string
  allowlist: string[]
  doh: boolean
}

export interface AdblockListInfo {
  id: string
  name: string
  description: string
  selected: boolean
  cachedAt: number | null
}

export interface AdblockStatus {
  enabled: boolean
  doh: boolean
  ready: boolean
  updating: boolean
  updatedAt: number
  error: string | null
  lists: AdblockListInfo[]
  customRules: string
  allowlist: string[]
  totalBlocked: number
  ruleCount: number
}

export interface AdblockTabStats {
  tabId: number
  host: string
  blocked: number
  allowed: boolean
}

export type PreferredQuality = 'ask' | 'best' | '1080' | '720' | '480' | 'worst'

export interface Settings {
  downloadDir: string
  vaultDir: string
  maxConcurrent: number
  connections: number
  preferredQuality: PreferredQuality
  remuxToMp4: boolean
  searchEngineId: string
  homeUrl: string
  toolPaths: { ytdlp?: string; ffmpeg?: string }
  autoUpdate: boolean
  detectMinSize: number
  interceptBrowserDownloads: boolean
  adblock: AdblockSettings
  popupBlock: PopupBlockSettings
  pageScan: PageScanSettings
  privacy: PrivacySettings
}

export interface AppNotification {
  type: 'info' | 'success' | 'error'
  message: string
  /** 토스트에 붙는 동작 버튼 (예: 차단된 팝업 열기) */
  action?: { label: string; url: string; tabId?: number }
}

export interface PopupBlockSettings {
  enabled: boolean
  allowlist: string[]
}

export type PopupBlockReason = 'no-gesture' | 'repeat' | 'filter' | 'tab-under'

export interface BlockedPopup {
  url: string
  reason: PopupBlockReason
  at: number
}

export interface PopupStats {
  tabId: number
  host: string
  enabled: boolean
  allowed: boolean
  items: BlockedPopup[]
}

export type PageId = 'browser' | 'downloads' | 'files' | 'player' | 'vault' | 'settings'

export interface NavigateEvent {
  page: PageId
  focusAddress?: boolean
  analyzeUrl?: string
  pageUrl?: string
}

export interface UpdateInfo {
  status: 'idle' | 'checking' | 'available' | 'not-available' | 'downloaded' | 'error' | 'unsupported'
  version?: string
  message?: string
}

export const MEDIA_EXTENSIONS = [
  'mp4', 'm4v', 'webm', 'mkv', 'mov', 'avi', 'flv', 'wmv', 'asf', '3gp', 'ogg', 'ogv', 'ts',
  'mp3', 'm4a', 'aac', 'wav', 'flac'
]

export const SEARCH_ENGINES: SearchEngine[] = [
  { id: 'google', name: 'Google', url: 'https://www.google.com/search?q=%s' },
  { id: 'naver', name: 'Naver', url: 'https://search.naver.com/search.naver?query=%s' },
  { id: 'daum', name: 'Daum', url: 'https://search.daum.net/search?q=%s' },
  { id: 'bing', name: 'Bing', url: 'https://www.bing.com/search?q=%s' },
  { id: 'duckduckgo', name: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=%s' },
  { id: 'yahoo', name: 'Yahoo', url: 'https://search.yahoo.com/search?p=%s' },
  { id: 'brave', name: 'Brave', url: 'https://search.brave.com/search?q=%s' },
  { id: 'yandex', name: 'Yandex', url: 'https://yandex.com/search/?text=%s' },
  { id: 'baidu', name: 'Baidu', url: 'https://www.baidu.com/s?wd=%s' },
  { id: 'ecosia', name: 'Ecosia', url: 'https://www.ecosia.org/search?q=%s' },
  { id: 'startpage', name: 'Startpage', url: 'https://www.startpage.com/do/search?q=%s' },
  { id: 'qwant', name: 'Qwant', url: 'https://www.qwant.com/?q=%s' }
]
