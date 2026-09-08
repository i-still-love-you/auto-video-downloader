import { app, type Session } from 'electron'
import { EventEmitter } from 'node:events'
import path from 'node:path'
import { JsonStore } from '../storage/jsonStore'
import { getSettings } from '../settings'
import type { DownloadManager } from '../downloads/manager'
import { cookieHeaderFor } from '../downloads/net'
import { PageLoader } from './crawler'
import { extractPageMedia, pickCandidate } from './extractors'
import { errorMessage, extOfUrl, isAbortError, newId, sanitizeFilename } from '../util'
import type {
  AnalyzeResult,
  AppNotification,
  BatchItem,
  BatchJob,
  BatchOptions,
  BatchPreview,
  DownloadTask,
  PreferredQuality
} from '@shared/types'

interface StoreData {
  jobs: BatchJob[]
}

export interface BatchDeps {
  downloads: DownloadManager
  /** 탭 id 로 그 탭의 세션을, 없으면 크롤러 전용 세션을 돌려준다 */
  sessionFor: (tabId?: number) => Session
  userAgent: string
}

/** 큐에 넣을 준비가 된(found) 항목이 이보다 적어지면 다음 목록 페이지를 읽는다 */
const LOOKAHEAD = 6
/** 동시에 영상 페이지를 확인하는 수 */
const RESOLVE_PARALLEL = 2
const MAX_VISITED = 3000
const FETCH_TIMEOUT = 25_000
const MAX_JOBS = 50

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

/** 목록 주소에 페이지 번호를 넣는다. 주소에 번호가 있으면 바꾸고, 없으면 `/N/` 을 붙인다. */
export function pageUrlFor(base: string, page: number): string {
  if (page <= 1) return base
  try {
    const u = new URL(base)
    if (/\/\d+\/?$/.test(u.pathname)) {
      u.pathname = u.pathname.replace(/\/\d+(\/?)$/, `/${page}$1`)
      return u.href
    }
    for (const key of ['page', 'p', 'pg']) {
      if (u.searchParams.has(key)) {
        u.searchParams.set(key, String(page))
        return u.href
      }
    }
    u.pathname = `${u.pathname.replace(/\/$/, '')}/${page}/`
    return u.href
  } catch {
    return base
  }
}

/** 명시적인 "다음" 링크가 없을 때 주소의 페이지 번호를 올려 본다. 번호가 없으면 추측하지 않는다. */
export function guessNextUrl(url: string): string | null {
  try {
    const u = new URL(url)
    const m = /\/(\d+)\/?$/.exec(u.pathname)
    if (m) {
      u.pathname = u.pathname.replace(/\/\d+(\/?)$/, `/${Number(m[1]) + 1}$1`)
      return u.href
    }
    for (const key of ['page', 'p', 'pg']) {
      const v = u.searchParams.get(key)
      if (v && /^\d+$/.test(v)) {
        u.searchParams.set(key, String(Number(v) + 1))
        return u.href
      }
    }
  } catch {
    /* ignore */
  }
  return null
}

export function normalizeOptions(o: Partial<BatchOptions> | undefined): BatchOptions {
  const num = (v: unknown, d: number, min: number, max: number): number => {
    const n = Math.floor(Number(v))
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d
  }
  const q = o?.quality
  const quality: BatchOptions['quality'] = q === 'best' || q === '1080' || q === '720' || q === '480' || q === 'worst' ? q : 'settings'
  return {
    startPage: num(o?.startPage, 1, 1, 100_000),
    maxPages: num(o?.maxPages, 0, 0, 100_000),
    maxItems: num(o?.maxItems, 0, 0, 100_000),
    quality,
    skipDownloaded: o?.skipDownloaded !== false,
    pageDelayMs: num(o?.pageDelayMs, 1500, 0, 600_000),
    filter: typeof o?.filter === 'string' ? o.filter.trim().slice(0, 200) : '',
    tabId: typeof o?.tabId === 'number' && Number.isInteger(o.tabId) ? o.tabId : undefined
  }
}

async function fetchHtml(ses: Session, url: string, referer: string | undefined, userAgent: string, signal: AbortSignal): Promise<string | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT)
  const onAbort = (): void => controller.abort()
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    const headers: Record<string, string> = {
      'User-Agent': userAgent,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'ko,en-US;q=0.8,en;q=0.6'
    }
    if (referer) headers.Referer = referer
    const res = await ses.fetch(url, { headers, signal: controller.signal, redirect: 'follow' })
    if (!res.ok) throw new Error(`영상 페이지 요청 실패 (HTTP ${res.status})`)
    const ct = (res.headers.get('content-type') ?? '').toLowerCase()
    if (ct && !/html|xml|text\/plain|json/.test(ct)) {
      // 페이지가 아니라 파일 자체 (직접 링크)
      await res.body?.cancel().catch(() => undefined)
      return null
    }
    const text = await res.text()
    return text.slice(0, 4_000_000)
  } catch (e) {
    if (signal.aborted) throw e
    if (controller.signal.aborted) throw new Error('영상 페이지 응답 시간이 초과되었습니다')
    throw e
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', onAbort)
  }
}

interface Counts {
  found: number
  resolving: number
  queued: number
  downloading: number
  completed: number
  error: number
  skipped: number
}

function countItems(job: BatchJob): Counts {
  const c: Counts = { found: 0, resolving: 0, queued: 0, downloading: 0, completed: 0, error: 0, skipped: 0 }
  for (const it of job.items) c[it.status]++
  return c
}

/**
 * 작업 하나를 실제로 굴리는 실행기. 목록 페이지를 필요할 때만 한 장씩 읽고(lookahead),
 * 영상 페이지에서 실제 주소를 찾아 다운로드 큐에 넣는다. 큐에는 동시 다운로드 수 + 2개까지만 미리 넣어
 * 다운로드 목록이 수백 개로 불어나지 않게 한다.
 */
class JobRunner {
  private loader: PageLoader | null = null
  private crawling = false
  private resolving = 0
  private tickScheduled = false
  private delayTimer: NodeJS.Timeout | null = null
  private lastCrawlAt = 0
  private abort = new AbortController()
  private finished = false

  constructor(
    readonly job: BatchJob,
    private readonly mgr: BatchManager,
    private readonly deps: BatchDeps
  ) {}

  start(): void {
    this.job.status = 'running'
    this.job.error = undefined
    this.mgr.changed(this.job, true)
    this.kick()
  }

  /** 새 작업을 멈춘다. 진행 중인 페이지 읽기·주소 확인은 중단되고, 이미 큐에 들어간 다운로드는 그대로 둔다. */
  halt(status: 'paused' | 'stopped' | 'error', error?: string): void {
    if (this.finished) return
    this.finished = true
    this.job.status = status
    if (error) this.job.error = error
    if (this.delayTimer) {
      clearTimeout(this.delayTimer)
      this.delayTimer = null
    }
    this.abort.abort()
    this.loader?.destroy()
    this.loader = null
    for (const it of this.job.items) if (it.status === 'resolving') it.status = 'found'
    this.mgr.changed(this.job, true)
  }

  kick(): void {
    if (this.finished || this.tickScheduled) return
    this.tickScheduled = true
    setImmediate(() => {
      this.tickScheduled = false
      try {
        this.tick()
      } catch (e) {
        this.halt('error', errorMessage(e))
        this.mgr.runnerDone(this.job.id)
      }
    })
  }

  private quality(): PreferredQuality {
    const q = this.job.options.quality
    if (q !== 'settings') return q
    const s = getSettings().preferredQuality
    return s === 'ask' ? 'best' : s
  }

  private tick(): void {
    const job = this.job
    if (this.finished || job.status !== 'running') return
    const counts = countItems(job)
    const pendingWork = counts.found + counts.resolving + counts.queued + counts.downloading

    if (job.pages.done && !this.crawling && this.resolving === 0 && pendingWork === 0) {
      this.finished = true
      job.status = 'completed'
      this.loader?.destroy()
      this.loader = null
      this.mgr.changed(job, true)
      this.mgr.notify({
        type: counts.error ? 'info' : 'success',
        message: `자동 다운로드 완료: ${job.title || job.host} (완료 ${counts.completed}${counts.error ? `, 실패 ${counts.error}` : ''}${counts.skipped ? `, 건너뜀 ${counts.skipped}` : ''})`
      })
      this.mgr.runnerDone(job.id)
      return
    }

    if (!job.pages.done && !this.crawling && counts.found < LOOKAHEAD) {
      const wait = this.lastCrawlAt ? job.options.pageDelayMs - (Date.now() - this.lastCrawlAt) : 0
      if (wait > 0) {
        if (!this.delayTimer) {
          this.delayTimer = setTimeout(() => {
            this.delayTimer = null
            this.kick()
          }, wait)
        }
      } else {
        this.crawling = true
        void this.crawlNext()
          .catch((e) => {
            if (this.finished || isAbortError(e)) return
            // 한 페이지 실패는 그 자리에서 끝낸 것으로 본다 (이미 찾은 항목은 계속 처리)
            job.pages.done = true
            job.error = `목록 페이지를 읽지 못했습니다: ${errorMessage(e)}`
          })
          .finally(() => {
            this.crawling = false
            this.lastCrawlAt = Date.now()
            if (!this.finished) {
              this.mgr.changed(job)
              this.kick()
            }
          })
      }
    }

    const windowSize = getSettings().maxConcurrent + 2
    let active = counts.queued + counts.downloading + this.resolving
    while (this.resolving < RESOLVE_PARALLEL && active < windowSize) {
      const item = job.items.find((i) => i.status === 'found')
      if (!item) break
      item.status = 'resolving'
      item.error = undefined
      this.resolving++
      active++
      void this.resolve(item).finally(() => {
        this.resolving--
        if (!this.finished) {
          this.mgr.changed(job)
          this.kick()
        }
      })
    }
    this.mgr.changed(job)
  }

  private async crawlNext(): Promise<void> {
    const job = this.job
    const url = job.pages.nextUrl
    if (!url) {
      job.pages.done = true
      return
    }
    if (job.options.maxPages > 0 && job.pages.scanned >= job.options.maxPages) {
      job.pages.done = true
      return
    }
    if (job.pages.visited.includes(url)) {
      job.pages.done = true
      return
    }
    if (!this.loader) this.loader = new PageLoader(this.deps.sessionFor(job.options.tabId))
    const page = await this.loader.load(url, { filter: job.options.filter, referer: job.pages.lastUrl, signal: this.abort.signal })
    if (this.finished) return

    job.pages.visited.push(url)
    if (page.url && page.url !== url) job.pages.visited.push(page.url)
    if (job.pages.visited.length > MAX_VISITED) job.pages.visited.splice(0, job.pages.visited.length - MAX_VISITED)
    job.pages.scanned++
    job.pages.lastUrl = page.url || url
    if (job.pages.scanned === 1 && page.title) job.title = page.title.trim().slice(0, 200)

    if (page.challenge) {
      job.pages.nextUrl = url
      job.pages.scanned--
      job.pages.visited = job.pages.visited.filter((v) => v !== url && v !== page.url)
      this.halt('paused', '사이트의 보안 확인 페이지에 막혔습니다. 브라우저 탭에서 이 사이트를 먼저 연 뒤 "이어서"를 눌러 주세요.')
      this.mgr.runnerDone(job.id)
      return
    }

    const existing = new Set(job.items.map((i) => i.url))
    let added = 0
    let limitHit = false
    for (const it of page.items) {
      if (existing.has(it.url)) continue
      if (job.options.maxItems > 0 && job.items.length >= job.options.maxItems) {
        limitHit = true
        break
      }
      existing.add(it.url)
      const item: BatchItem = {
        id: newId(),
        url: it.url,
        title: it.title || it.url,
        thumb: it.thumb,
        duration: it.duration,
        page: job.pages.scanned,
        status: 'found',
        addedAt: Date.now()
      }
      if (job.options.skipDownloaded) {
        const done = this.deps.downloads.findCompletedFor(it.url)
        if (done) {
          item.status = 'skipped'
          item.taskId = done.id
          item.error = '이미 받은 영상'
        }
      }
      job.items.push(item)
      added++
    }

    if (limitHit || (job.options.maxPages > 0 && job.pages.scanned >= job.options.maxPages)) {
      job.pages.done = true
      job.pages.nextUrl = null
      return
    }
    // 영상 링크가 하나도 없는 페이지(끝을 지난 페이지)면 끝. 필터에 걸러져 비어 보이는 페이지는 total 로 구분한다.
    if (!page.total || (page.httpStatus >= 400 && !added)) {
      job.pages.done = true
      job.pages.nextUrl = null
      return
    }
    let next = page.next && !job.pages.visited.includes(page.next) ? page.next : null
    // 명시적 "다음" 링크가 없으면 주소의 페이지 번호를 올려 본다. 단, 이 페이지가 전부 이미 본 항목이면(같은 내용 반복) 멈춘다.
    const fresh = added > 0 || page.items.length === 0
    if (!next && fresh) next = guessNextUrl(page.url || url)
    if (next && job.pages.visited.includes(next)) next = null
    if (!page.next && !fresh) next = null
    job.pages.nextUrl = next
    if (!next) job.pages.done = true
  }

  private async resolve(item: BatchItem): Promise<void> {
    const job = this.job
    try {
      const analyze = await this.analyzeItem(item)
      if (this.finished || job.status !== 'running') {
        item.status = 'found'
        return
      }
      const task = this.deps.downloads.enqueue({ analyze, quality: this.quality(), batchId: job.id })
      item.taskId = task.id
      item.mediaUrl = analyze.url
      item.status = 'queued'
      item.error = undefined
    } catch (e) {
      if (this.finished || job.status !== 'running' || isAbortError(e)) {
        item.status = 'found'
        return
      }
      item.status = 'error'
      item.error = errorMessage(e)
    }
  }

  private async analyzeItem(item: BatchItem): Promise<AnalyzeResult> {
    const job = this.job
    const ses = this.deps.sessionFor(job.options.tabId)
    const html = await fetchHtml(ses, item.url, job.sourceUrl, this.deps.userAgent, this.abort.signal)
    const media = html ? extractPageMedia(html, item.url) : null
    if (media?.candidates.length) {
      const pick = pickCandidate(media.candidates, this.quality())
      const headers: Record<string, string> = { Referer: item.url, 'User-Agent': this.deps.userAgent }
      const cookie = await cookieHeaderFor(ses, pick.url)
      if (cookie) headers.Cookie = cookie
      const title = sanitizeFilename((media.title || item.title || 'video').trim())
      const ext = extOfUrl(pick.url)
      item.extractor = media.source
      if (media.source === 'kvs' && ext !== 'm3u8' && ext !== 'mpd') {
        return { kind: 'file', url: pick.url, title, thumbnail: media.thumbnail, headers, pageUrl: item.url }
      }
      // 재생목록이나 일반 페이지에서 찾은 주소는 기존 분석기로 형식(HLS 변형 등)을 확인한다
      const r = await this.deps.downloads.analyze(pick.url, headers, item.url, title, job.options.tabId)
      if (!r.thumbnail && media.thumbnail) r.thumbnail = media.thumbnail
      return r
    }
    // 페이지에서 못 찾으면 yt-dlp 에 맡긴다
    item.extractor = 'ytdlp'
    return this.deps.downloads.analyze(item.url, { Referer: job.sourceUrl }, item.url, item.title, job.options.tabId)
  }
}

/**
 * 자동(일괄) 다운로드 작업 관리. 목록 페이지 주소 하나로 페이지를 넘겨 가며 영상을 모두 큐에 넣는다.
 * 이벤트: 'update'(BatchJob), 'removed'(id), 'notify'(AppNotification)
 */
export class BatchManager extends EventEmitter {
  private store: JsonStore<StoreData>
  private jobs = new Map<string, BatchJob>()
  private order: string[] = []
  private runners = new Map<string, JobRunner>()
  private emitTimers = new Map<string, NodeJS.Timeout>()
  private previewLoaders = new Set<PageLoader>()

  constructor(private readonly deps: BatchDeps) {
    super()
    this.store = new JsonStore<StoreData>(path.join(app.getPath('userData'), 'batch.json'), () => ({ jobs: [] }))
    deps.downloads.on('update', (t: DownloadTask) => this.onTask(t))
    deps.downloads.on('removed', (id: string) => this.onTaskRemoved(id))
  }

  async init(): Promise<void> {
    const data = await this.store.load()
    for (const job of data.jobs) {
      if (!job || typeof job.id !== 'string') continue
      job.options = normalizeOptions(job.options)
      const pages: Partial<BatchJob['pages']> = job.pages ?? {}
      job.pages = {
        scanned: typeof pages.scanned === 'number' ? pages.scanned : 0,
        nextUrl: typeof pages.nextUrl === 'string' ? pages.nextUrl : pages.nextUrl === null ? null : job.sourceUrl,
        lastUrl: typeof pages.lastUrl === 'string' ? pages.lastUrl : undefined,
        done: !!pages.done,
        visited: Array.isArray(pages.visited) ? pages.visited : []
      }
      job.items = Array.isArray(job.items) ? job.items : []
      if (job.status === 'running') job.status = 'paused'
      for (const it of job.items) {
        if (it.status === 'resolving') it.status = 'found'
        if ((it.status === 'queued' || it.status === 'downloading') && it.taskId) {
          const t = this.deps.downloads.get(it.taskId)
          if (!t) it.status = 'found'
          else this.applyTaskStatus(it, t)
        }
      }
      this.jobs.set(job.id, job)
      this.order.push(job.id)
    }
  }

  list(): BatchJob[] {
    return this.order.map((id) => this.jobs.get(id)!).filter(Boolean)
  }

  get(id: string): BatchJob | undefined {
    return this.jobs.get(id)
  }

  notify(n: AppNotification): void {
    this.emit('notify', n)
  }

  /** 작업 상태를 렌더러에 알린다 (기본 250ms 스로틀) 하고 저장을 예약한다 */
  changed(job: BatchJob, immediate = false): void {
    job.updatedAt = Date.now()
    this.store.get().jobs = this.list()
    this.store.scheduleSaveThrottled(2000)
    if (immediate) {
      const t = this.emitTimers.get(job.id)
      if (t) {
        clearTimeout(t)
        this.emitTimers.delete(job.id)
      }
      this.emit('update', job)
      return
    }
    if (this.emitTimers.has(job.id)) return
    this.emitTimers.set(
      job.id,
      setTimeout(() => {
        this.emitTimers.delete(job.id)
        if (this.jobs.has(job.id)) this.emit('update', job)
      }, 250)
    )
  }

  runnerDone(id: string): void {
    this.runners.delete(id)
  }

  // ---------- 다운로드 작업 상태 반영 ----------

  private applyTaskStatus(item: BatchItem, t: DownloadTask): boolean {
    const prev = item.status
    switch (t.status) {
      case 'running':
        item.status = 'downloading'
        break
      case 'queued':
      case 'paused':
        item.status = 'queued'
        break
      case 'completed':
        item.status = 'completed'
        item.error = undefined
        break
      case 'error':
        item.status = 'error'
        item.error = t.error ?? '다운로드 실패'
        break
      case 'canceled':
        item.status = 'skipped'
        item.error = '취소됨'
        break
    }
    return prev !== item.status
  }

  private onTask(t: DownloadTask): void {
    if (!t.batchId) return
    const job = this.jobs.get(t.batchId)
    if (!job) return
    const item = job.items.find((i) => i.taskId === t.id)
    if (!item || item.status === 'skipped' && t.status !== 'completed') return
    if (this.applyTaskStatus(item, t)) {
      this.changed(job)
      this.runners.get(job.id)?.kick()
    }
  }

  private onTaskRemoved(id: string): void {
    for (const job of this.jobs.values()) {
      const item = job.items.find((i) => i.taskId === id)
      if (!item) continue
      if (item.status === 'queued' || item.status === 'downloading') {
        item.status = 'skipped'
        item.error = '다운로드 목록에서 제거됨'
        this.changed(job)
        this.runners.get(job.id)?.kick()
      }
    }
  }

  // ---------- 작업 제어 ----------

  create(url: string, options?: Partial<BatchOptions>): BatchJob {
    const src = url.trim()
    if (!/^https?:\/\//i.test(src)) throw new Error('http(s) 주소만 사용할 수 있습니다')
    const opts = normalizeOptions(options)
    const job: BatchJob = {
      id: newId(),
      sourceUrl: src,
      title: '',
      host: hostOf(src),
      options: opts,
      status: 'paused',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      pages: { scanned: 0, nextUrl: pageUrlFor(src, opts.startPage), done: false, visited: [] },
      items: []
    }
    this.jobs.set(job.id, job)
    this.order.unshift(job.id)
    while (this.order.length > MAX_JOBS) {
      const old = this.order[this.order.length - 1]
      const oj = this.jobs.get(old)
      if (!oj || oj.status === 'running') break
      this.order.pop()
      this.jobs.delete(old)
      this.emit('removed', old)
    }
    this.launch(job)
    return job
  }

  private launch(job: BatchJob): void {
    if (this.runners.has(job.id)) return
    const runner = new JobRunner(job, this, this.deps)
    this.runners.set(job.id, runner)
    runner.start()
  }

  resume(id: string): void {
    const job = this.jobs.get(id)
    if (!job) return
    if (job.status === 'running') return
    if (job.status === 'completed') {
      // 완료된 작업을 다시 실행하면 실패·건너뛴 항목은 두고, 남은 목록 페이지가 있으면 이어서 읽는다
      if (job.pages.done && !job.items.some((i) => i.status === 'found' || i.status === 'error')) return
    }
    job.error = undefined
    if (!job.pages.done && !job.pages.nextUrl) job.pages.done = true
    this.launch(job)
  }

  pause(id: string): void {
    const job = this.jobs.get(id)
    if (!job) return
    const r = this.runners.get(id)
    if (r) {
      r.halt('paused')
      this.runners.delete(id)
    } else if (job.status === 'running') {
      job.status = 'paused'
      this.changed(job, true)
    }
  }

  /** 멈추고 이 작업이 큐에 넣은 진행 중 다운로드도 취소한다 */
  stop(id: string): void {
    const job = this.jobs.get(id)
    if (!job) return
    const r = this.runners.get(id)
    if (r) {
      r.halt('stopped')
      this.runners.delete(id)
    } else {
      job.status = 'stopped'
    }
    for (const it of job.items) {
      if ((it.status === 'queued' || it.status === 'downloading') && it.taskId) this.deps.downloads.cancel(it.taskId)
    }
    this.changed(job, true)
  }

  async remove(id: string, cancelTasks = false): Promise<void> {
    const job = this.jobs.get(id)
    if (!job) return
    const r = this.runners.get(id)
    if (r) {
      r.halt('stopped')
      this.runners.delete(id)
    }
    if (cancelTasks) {
      for (const it of job.items) {
        if ((it.status === 'queued' || it.status === 'downloading') && it.taskId) this.deps.downloads.cancel(it.taskId)
      }
    }
    const t = this.emitTimers.get(id)
    if (t) {
      clearTimeout(t)
      this.emitTimers.delete(id)
    }
    this.jobs.delete(id)
    this.order = this.order.filter((x) => x !== id)
    this.store.get().jobs = this.list()
    this.store.scheduleSave()
    this.emit('removed', id)
  }

  retryFailed(id: string): void {
    const job = this.jobs.get(id)
    if (!job) return
    let n = 0
    for (const it of job.items) {
      if (it.status === 'error') {
        it.status = 'found'
        it.error = undefined
        it.taskId = undefined
        n++
      }
    }
    if (!n && job.status === 'running') return
    this.changed(job, true)
    if (job.status === 'running') this.runners.get(id)?.kick()
    else this.resume(id)
  }

  retryItem(id: string, itemId: string): void {
    const job = this.jobs.get(id)
    const it = job?.items.find((i) => i.id === itemId)
    if (!job || !it) return
    if (it.status === 'error' || it.status === 'skipped') {
      it.status = 'found'
      it.error = undefined
      it.taskId = undefined
      this.changed(job, true)
      if (job.status === 'running') this.runners.get(id)?.kick()
      else this.resume(id)
    }
  }

  skipItem(id: string, itemId: string): void {
    const job = this.jobs.get(id)
    const it = job?.items.find((i) => i.id === itemId)
    if (!job || !it) return
    if (it.status === 'found' || it.status === 'error' || it.status === 'resolving') {
      it.status = 'skipped'
      it.error = '사용자가 제외'
      this.changed(job, true)
      this.runners.get(id)?.kick()
    } else if ((it.status === 'queued' || it.status === 'downloading') && it.taskId) {
      this.deps.downloads.cancel(it.taskId)
    }
  }

  /** 시작 전에 첫 목록 페이지만 읽어 어떤 영상이 잡히는지 보여 준다 */
  async preview(url: string, tabId?: number, filter?: string): Promise<BatchPreview> {
    const src = url.trim()
    if (!/^https?:\/\//i.test(src)) throw new Error('http(s) 주소만 사용할 수 있습니다')
    const loader = new PageLoader(this.deps.sessionFor(tabId))
    this.previewLoaders.add(loader)
    try {
      const page = await loader.load(src, { filter })
      return { url: page.url || src, title: page.title, items: page.items, total: page.total, next: page.next, challenge: page.challenge }
    } finally {
      this.previewLoaders.delete(loader)
      loader.destroy()
    }
  }

  /** 창이 닫힐 때: 실행 중인 작업을 일시정지하고 숨김 창을 모두 없앤다 */
  pauseAll(): void {
    for (const [id, r] of this.runners) {
      r.halt('paused')
      this.runners.delete(id)
    }
    for (const l of this.previewLoaders) l.destroy()
    this.previewLoaders.clear()
  }

  async shutdown(): Promise<void> {
    this.pauseAll()
    for (const t of this.emitTimers.values()) clearTimeout(t)
    this.emitTimers.clear()
    this.store.get().jobs = this.list()
    this.store.scheduleSave(0)
    await this.store.flush()
  }
}
