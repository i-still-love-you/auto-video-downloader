import { app, shell, type Session } from 'electron'
import { EventEmitter } from 'node:events'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import { JsonStore } from '../storage/jsonStore'
import { getSettings } from '../settings'
import { toolPath } from '../tools/binaries'
import { classify } from '../browser/sniffer'
import { DEFAULT_UA, cookieHeaderFor, exportCookieFile, fetchMedia, headerValue, normalizeHeaders } from './net'
import { cleanupHttp, runHttp, stripMediaExt } from './engines/http'
import { cleanupHls, fetchText, parsePlaylist, pickVariant, runHls } from './engines/hls'
import { analyzeWithYtdlp, buildSelector, runYtdlp } from './engines/ytdlp'
import type { EngineContext } from './engines/types'
import { localThumbnail, remoteThumbnail } from '../thumbnails'
import { basenameOfUrl, errorMessage, extOfUrl, isAbortError, isMediaExt, newId, parseContentDisposition, rmrf, sanitizeFilename } from '../util'
import type {
  AnalyzeResult,
  AppNotification,
  DetectedMedia,
  DownloadProgress,
  DownloadTask,
  EnqueueRequest
} from '@shared/types'

interface StoreData {
  tasks: DownloadTask[]
}
interface Running {
  controller: AbortController
  reason?: 'pause' | 'cancel'
  removeAfter?: { deleteFile: boolean }
}
interface Probe {
  status: number
  mime: string
  size: number | null
  disp: string | null
  finalUrl: string
}

const SPEED_WINDOW_MS = 5000

/**
 * 다운로드 큐/상태 관리. 이벤트: 'update'(task), 'removed'(id), 'notify'(AppNotification)
 */
export class DownloadManager extends EventEmitter {
  private store: JsonStore<StoreData>
  private tasks = new Map<string, DownloadTask>()
  private order: string[] = []
  private running = new Map<string, Running>()
  private samples = new Map<string, Array<{ t: number; b: number }>>()
  private emitTimers = new Map<string, NodeJS.Timeout>()
  private browserSession: Session | null = null
  private logs = new Map<string, string[]>()

  constructor() {
    super()
    this.store = new JsonStore<StoreData>(path.join(app.getPath('userData'), 'downloads.json'), () => ({ tasks: [] }))
  }

  setBrowserSession(s: Session): void {
    this.browserSession = s
  }

  async init(): Promise<void> {
    const data = await this.store.load()
    for (const t of data.tasks) {
      if (t.status === 'running') t.status = 'paused'
      if (t.status === 'queued') t.status = 'paused'
      t.progress = t.progress ?? { downloaded: 0, total: null, speed: 0, eta: null, percent: null }
      t.progress.speed = 0
      t.progress.eta = null
      this.tasks.set(t.id, t)
      this.order.push(t.id)
    }
  }

  list(): DownloadTask[] {
    return this.order.map((id) => this.tasks.get(id)!).filter(Boolean)
  }

  get(id: string): DownloadTask | undefined {
    return this.tasks.get(id)
  }

  getLog(id: string): string[] {
    return this.logs.get(id) ?? []
  }

  private workDirFor(id: string): string {
    return path.join(app.getPath('userData'), 'work', id)
  }

  private notify(n: AppNotification): void {
    this.emit('notify', n)
  }

  // ---------- 분석 ----------

  private async enrichHeaders(url: string, headers: Record<string, string>, pageUrl?: string): Promise<Record<string, string>> {
    const h = normalizeHeaders(headers)
    if (!headerValue(h, 'referer') && pageUrl) h.Referer = pageUrl
    if (!headerValue(h, 'user-agent')) h['User-Agent'] = this.browserSession?.getUserAgent() ?? DEFAULT_UA
    if (!headerValue(h, 'cookie')) {
      const ck = await cookieHeaderFor(this.browserSession, url)
      if (ck) h.Cookie = ck
    }
    return h
  }

  async analyze(rawUrl: string, headers: Record<string, string> = {}, pageUrl?: string, pageTitle?: string): Promise<AnalyzeResult> {
    const url = rawUrl.trim()
    if (!/^https?:\/\//i.test(url)) throw new Error('http(s) 주소만 분석할 수 있습니다')
    const hdrs = await this.enrichHeaders(url, headers, pageUrl)
    const ext = extOfUrl(url)
    if (ext === 'm3u8') return this.analyzeHls(url, hdrs, pageUrl, pageTitle)
    if (ext === 'mpd') return this.analyzeYtdlp(url, hdrs, pageUrl)

    let probe: Probe | null = null
    try {
      probe = await this.probe(url, hdrs)
    } catch {
      probe = null
    }
    if (probe && probe.status < 400) {
      const c = classify(probe.finalUrl, probe.mime, probe.size, probe.disp ?? undefined)
      if (c?.kind === 'hls') return this.analyzeHls(url, hdrs, pageUrl, pageTitle)
      if (c?.kind === 'file' || (isMediaExt(ext) && !/text\/html/i.test(probe.mime))) {
        return this.fileResult(url, hdrs, probe, pageUrl, pageTitle)
      }
      if (c?.kind === 'dash') return this.analyzeYtdlp(url, hdrs, pageUrl)
    }
    return this.analyzeYtdlp(url, hdrs, pageUrl)
  }

  async analyzeDetected(item: DetectedMedia): Promise<AnalyzeResult> {
    const hdrs = await this.enrichHeaders(item.url, item.headers, item.pageUrl)
    if (item.kind === 'hls') return this.analyzeHls(item.url, hdrs, item.pageUrl, item.pageTitle)
    if (item.kind === 'dash' || item.kind === 'page') return this.analyzeYtdlp(item.url, hdrs, item.pageUrl)
    if (item.found === 'scan') {
      // 페이지에서 긁은 주소는 실제로 받을 수 있는지 먼저 확인한다
      return this.analyze(item.url, hdrs, item.pageUrl, item.pageTitle)
    }
    return {
      kind: 'file',
      url: item.url,
      title: this.titleFor(item.filename, item.pageTitle, item.url),
      size: item.size,
      mime: item.mime,
      headers: hdrs,
      pageUrl: item.pageUrl
    }
  }

  private titleFor(filename: string | null | undefined, pageTitle: string | undefined, url: string): string {
    const fromFile = filename ? stripMediaExt(filename) : ''
    const fromPage = (pageTitle ?? '').trim()
    return sanitizeFilename(fromPage || fromFile || stripMediaExt(basenameOfUrl(url)) || 'video')
  }

  private async probe(url: string, headers: Record<string, string>): Promise<Probe> {
    const res = await fetchMedia(url, { headers, range: 'bytes=0-0', timeoutMs: 15_000 })
    let size: number | null = null
    const cr = res.headers.get('content-range')
    const m = cr ? /\/(\d+)\s*$/.exec(cr) : null
    if (m) size = Number(m[1])
    else {
      const cl = res.headers.get('content-length')
      if (cl && /^\d+$/.test(cl) && res.status !== 206) size = Number(cl)
    }
    const out: Probe = {
      status: res.status,
      mime: res.headers.get('content-type') ?? '',
      size,
      disp: res.headers.get('content-disposition'),
      finalUrl: res.url || url
    }
    await res.body?.cancel().catch(() => undefined)
    return out
  }

  private fileResult(url: string, headers: Record<string, string>, probe: Probe, pageUrl?: string, pageTitle?: string): AnalyzeResult {
    const disp = parseContentDisposition(probe.disp)
    return {
      kind: 'file',
      url,
      title: this.titleFor(disp ?? basenameOfUrl(url), pageTitle, url),
      size: probe.size,
      mime: probe.mime.split(';')[0].trim(),
      headers,
      pageUrl
    }
  }

  private async analyzeHls(url: string, headers: Record<string, string>, pageUrl?: string, pageTitle?: string): Promise<AnalyzeResult> {
    const parsed = parsePlaylist(await fetchText(url, headers), url)
    const title = this.titleFor(basenameOfUrl(url).replace(/\.m3u8$/i, ''), pageTitle, url)
    if (parsed.type === 'master') {
      return { kind: 'hls', url, title, variants: parsed.variants, headers, pageUrl }
    }
    if (parsed.live) throw new Error('라이브 스트림은 다운로드할 수 없습니다')
    return { kind: 'hls', url, title, duration: parsed.totalDuration, headers, pageUrl }
  }

  private async analyzeYtdlp(url: string, headers: Record<string, string>, pageUrl?: string): Promise<AnalyzeResult> {
    const ytdlp = await toolPath('ytdlp')
    if (!ytdlp) throw new Error('이 주소는 yt-dlp 로 분석해야 합니다. 설정 > 도구에서 yt-dlp 를 설치해 주세요.')
    const cookieFile = await exportCookieFile(this.browserSession, pageUrl ?? url)
    const clean = { ...headers }
    delete clean.Cookie
    if (!cookieFile && headers.Cookie) clean.Cookie = headers.Cookie
    const result = await analyzeWithYtdlp(ytdlp, url, clean, cookieFile)
    result.pageUrl = pageUrl
    return result
  }

  // ---------- 큐 ----------

  enqueue(req: EnqueueRequest): DownloadTask {
    const s = getSettings()
    const a = req.analyze
    const filename = req.filename?.trim() ? stripMediaExt(sanitizeFilename(req.filename)) : undefined
    const task: DownloadTask = {
      id: newId(),
      engine: a.kind === 'file' ? 'http' : a.kind === 'hls' ? 'hls' : 'ytdlp',
      url: a.url,
      title: a.title,
      pageUrl: a.pageUrl,
      headers: a.headers,
      cookieFile: a.cookieFile,
      outputDir: s.downloadDir,
      filename,
      status: 'queued',
      progress: { downloaded: 0, total: a.size ?? null, speed: 0, eta: null, percent: null },
      createdAt: Date.now(),
      thumbnail: a.thumbnail,
      size: a.size ?? null,
      mime: a.mime
    }
    if (a.kind === 'hls' && a.variants?.length) {
      const idx = req.selection !== undefined && req.selection !== '' ? Number(req.selection) : NaN
      task.variant = Number.isInteger(idx) && a.variants[idx] ? a.variants[idx] : pickVariant(a.variants, s.preferredQuality)
    }
    if (a.kind === 'ytdlp') task.formatId = buildSelector(req.selection, a.formats, s.preferredQuality)
    this.add(task)
    return task
  }

  /** 감지 항목을 분석 창 없이 기본 화질 설정으로 바로 큐에 넣는다. */
  async quickDownload(item: DetectedMedia): Promise<DownloadTask> {
    const analyze = await this.analyzeDetected(item)
    return this.enqueue({ analyze })
  }

  /** 브라우저 will-download / 우클릭 등에서 바로 추가 */
  enqueueDirect(opts: { url: string; title?: string; filename?: string; headers?: Record<string, string>; size?: number | null; mime?: string; pageUrl?: string }): DownloadTask {
    const s = getSettings()
    const task: DownloadTask = {
      id: newId(),
      engine: 'http',
      url: opts.url,
      title: opts.title || this.titleFor(opts.filename, undefined, opts.url),
      pageUrl: opts.pageUrl,
      headers: normalizeHeaders(opts.headers),
      outputDir: s.downloadDir,
      filename: opts.filename ? stripMediaExt(sanitizeFilename(opts.filename)) : undefined,
      status: 'queued',
      progress: { downloaded: 0, total: opts.size ?? null, speed: 0, eta: null, percent: null },
      createdAt: Date.now(),
      size: opts.size ?? null,
      mime: opts.mime
    }
    this.add(task)
    return task
  }

  private add(task: DownloadTask): void {
    this.tasks.set(task.id, task)
    this.order.unshift(task.id)
    this.persist()
    this.emitNow(task)
    this.tick()
    if (!task.thumbnail && task.engine !== 'ytdlp') void this.attachRemoteThumbnail(task)
  }

  private async attachRemoteThumbnail(task: DownloadTask): Promise<void> {
    try {
      const url = await remoteThumbnail(task.url, task.headers)
      const t = this.tasks.get(task.id)
      if (url && t && !t.thumbnail) {
        t.thumbnail = url
        this.emitNow(t)
        this.persist()
      }
    } catch {
      /* 썸네일 실패는 무시 */
    }
  }

  private async attachLocalThumbnail(task: DownloadTask): Promise<void> {
    if (!task.filePath) return
    try {
      const r = await localThumbnail(task.filePath)
      const t = this.tasks.get(task.id)
      if (r.url && t) {
        t.thumbnail = r.url
        this.emitNow(t)
        this.persist()
      }
    } catch {
      /* 썸네일 실패는 무시 */
    }
  }

  pause(id: string): void {
    const t = this.tasks.get(id)
    if (!t) return
    const r = this.running.get(id)
    if (r) {
      r.reason = 'pause'
      r.controller.abort()
    } else if (t.status === 'queued') {
      t.status = 'paused'
      this.emitNow(t)
      this.persist()
    }
  }

  resume(id: string): void {
    const t = this.tasks.get(id)
    if (!t || this.running.has(id)) return
    if (t.status === 'paused' || t.status === 'error' || t.status === 'canceled') {
      t.status = 'queued'
      t.error = undefined
      this.emitNow(t)
      this.persist()
      this.tick()
    }
  }

  retry(id: string): void {
    this.resume(id)
  }

  cancel(id: string): void {
    const t = this.tasks.get(id)
    if (!t) return
    const r = this.running.get(id)
    if (r) {
      r.reason = 'cancel'
      r.controller.abort()
    } else if (t.status !== 'completed') {
      t.status = 'canceled'
      void this.cleanup(t)
      this.emitNow(t)
      this.persist()
    }
  }

  async remove(id: string, deleteFile = false): Promise<void> {
    const t = this.tasks.get(id)
    if (!t) return
    const r = this.running.get(id)
    if (r) {
      r.reason = 'cancel'
      r.removeAfter = { deleteFile }
      r.controller.abort()
      return
    }
    await this.finalizeRemove(t, deleteFile)
  }

  private async finalizeRemove(t: DownloadTask, deleteFile: boolean): Promise<void> {
    if (t.status !== 'completed') await this.cleanup(t)
    if (deleteFile && t.filePath) await fs.rm(t.filePath, { force: true }).catch(() => undefined)
    this.tasks.delete(t.id)
    this.order = this.order.filter((x) => x !== t.id)
    this.logs.delete(t.id)
    this.emit('removed', t.id)
    this.persist()
  }

  clearFinished(): void {
    for (const t of this.list()) {
      if (t.status === 'completed' || t.status === 'canceled') {
        this.tasks.delete(t.id)
        this.order = this.order.filter((x) => x !== t.id)
        this.emit('removed', t.id)
      }
    }
    this.persist()
  }

  async openFile(id: string): Promise<string> {
    const t = this.tasks.get(id)
    if (!t?.filePath) return '파일이 없습니다'
    return shell.openPath(t.filePath)
  }

  showInFolder(id: string): void {
    const t = this.tasks.get(id)
    if (t?.filePath) shell.showItemInFolder(t.filePath)
  }

  private async cleanup(t: DownloadTask): Promise<void> {
    const workDir = this.workDirFor(t.id)
    if (t.engine === 'http') await cleanupHttp(t)
    else if (t.engine === 'hls') await cleanupHls(t, workDir)
    else if (t.filePath) {
      for (const suffix of ['', '.part', '.ytdl']) await fs.rm(t.filePath + suffix, { force: true }).catch(() => undefined)
    }
    await rmrf(workDir)
  }

  // ---------- 실행 ----------

  private tick(): void {
    const max = getSettings().maxConcurrent
    for (const id of [...this.order].reverse()) {
      if (this.running.size >= max) break
      const t = this.tasks.get(id)
      if (t && t.status === 'queued' && !this.running.has(id)) void this.run(t)
    }
  }

  private async run(task: DownloadTask): Promise<void> {
    const controller = new AbortController()
    const state: Running = { controller }
    this.running.set(task.id, state)
    task.status = 'running'
    task.startedAt = task.startedAt ?? Date.now()
    task.error = undefined
    task.progress.speed = 0
    task.progress.eta = null
    this.samples.set(task.id, [])
    this.emitNow(task)
    this.persist()

    const ctx: EngineContext = {
      task,
      signal: controller.signal,
      workDir: this.workDirFor(task.id),
      settings: getSettings(),
      tools: { ffmpeg: await toolPath('ffmpeg'), ytdlp: await toolPath('ytdlp') },
      onProgress: (p) => this.applyProgress(task, p),
      onFile: (fp) => {
        task.filePath = fp
      },
      log: (line) => {
        const arr = this.logs.get(task.id) ?? []
        arr.push(line)
        if (arr.length > 300) arr.splice(0, arr.length - 300)
        this.logs.set(task.id, arr)
      }
    }

    try {
      let filePath: string
      if (task.engine === 'http') filePath = await runHttp(ctx)
      else if (task.engine === 'hls') filePath = await runHls(ctx)
      else filePath = await runYtdlp(ctx)
      task.filePath = filePath
      task.status = 'completed'
      task.completedAt = Date.now()
      task.progress.percent = 100
      task.progress.speed = 0
      task.progress.eta = null
      if (task.progress.total === null || task.progress.total < task.progress.downloaded) task.progress.total = task.progress.downloaded
      try {
        const st = await fs.stat(filePath)
        task.size = st.size
        task.progress.total = st.size
        task.progress.downloaded = st.size
      } catch {
        /* ignore */
      }
      this.notify({ type: 'success', message: `다운로드 완료: ${path.basename(filePath)}` })
      void this.attachLocalThumbnail(task)
    } catch (err) {
      const r = this.running.get(task.id)
      if (r?.reason === 'pause' || (isAbortError(err) && r?.reason !== 'cancel')) {
        task.status = 'paused'
      } else if (r?.reason === 'cancel') {
        task.status = 'canceled'
        await this.cleanup(task)
      } else {
        task.status = 'error'
        task.error = errorMessage(err)
        this.notify({ type: 'error', message: `다운로드 실패: ${task.title} - ${task.error}` })
      }
      task.progress.speed = 0
      task.progress.eta = null
    } finally {
      const r = this.running.get(task.id)
      this.running.delete(task.id)
      this.samples.delete(task.id)
      this.emitNow(task)
      this.persist()
      if (r?.removeAfter) await this.finalizeRemove(task, r.removeAfter.deleteFile)
      this.tick()
    }
  }

  private applyProgress(task: DownloadTask, p: Partial<DownloadProgress>): void {
    const pr = task.progress
    if (p.downloaded !== undefined) pr.downloaded = p.downloaded
    if (p.total !== undefined) pr.total = p.total
    if (p.segmentsDone !== undefined) pr.segmentsDone = p.segmentsDone
    if (p.segmentsTotal !== undefined) pr.segmentsTotal = p.segmentsTotal
    if (p.stage !== undefined) pr.stage = p.stage

    const now = Date.now()
    let samples = this.samples.get(task.id)
    if (!samples) {
      samples = []
      this.samples.set(task.id, samples)
    }
    const last = samples[samples.length - 1]
    if (last && pr.downloaded < last.b) samples.length = 0
    samples.push({ t: now, b: pr.downloaded })
    while (samples.length > 2 && now - samples[0].t > SPEED_WINDOW_MS) samples.shift()
    if (samples.length >= 2) {
      const first = samples[0]
      const lastS = samples[samples.length - 1]
      const dt = (lastS.t - first.t) / 1000
      pr.speed = dt > 0.2 ? (lastS.b - first.b) / dt : pr.speed
    }

    if (p.percent !== undefined) pr.percent = p.percent
    else if (pr.total && pr.total > 0) pr.percent = Math.min(99.9, (pr.downloaded / pr.total) * 100)
    pr.eta = pr.total && pr.speed > 0 && pr.total > pr.downloaded ? (pr.total - pr.downloaded) / pr.speed : null
    this.emitThrottled(task)
  }

  private emitThrottled(task: DownloadTask): void {
    if (this.emitTimers.has(task.id)) return
    this.emitTimers.set(
      task.id,
      setTimeout(() => {
        this.emitTimers.delete(task.id)
        this.emit('update', task)
        this.persist(true)
      }, 250)
    )
  }

  private emitNow(task: DownloadTask): void {
    const t = this.emitTimers.get(task.id)
    if (t) {
      clearTimeout(t)
      this.emitTimers.delete(task.id)
    }
    this.emit('update', task)
  }

  private persist(throttled = false): void {
    this.store.get().tasks = this.list()
    if (throttled) this.store.scheduleSaveThrottled(2000)
    else this.store.scheduleSave()
  }

  async shutdown(): Promise<void> {
    const waits: Array<Promise<void>> = []
    for (const [id, r] of this.running) {
      r.reason = 'pause'
      r.controller.abort()
      waits.push(
        new Promise<void>((resolve) => {
          const check = (): void => {
            if (!this.running.has(id)) resolve()
            else setTimeout(check, 50)
          }
          check()
          setTimeout(resolve, 3000)
        })
      )
    }
    await Promise.all(waits)
    this.store.get().tasks = this.list()
    this.store.scheduleSave(0)
    await this.store.flush()
  }
}
