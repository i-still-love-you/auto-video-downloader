// 메인 프로세스와 렌더러가 함께 사용하는 타입 정의

export type MediaKind = 'file' | 'hls' | 'dash'

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
}

export interface AppNotification {
  type: 'info' | 'success' | 'error'
  message: string
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
