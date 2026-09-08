import { app, ipcMain, webContents, type IpcMainInvokeEvent, type Session } from 'electron'
import { EventEmitter } from 'node:events'
import { existsSync, promises as fs } from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { Worker } from 'node:worker_threads'
import { ElectronBlocker, Request, fetchResources } from '@ghostery/adblocker-electron'
import type { AdblockListInfo, AdblockSettings, AdblockStatus, AdblockTabStats } from '@shared/types'
import { getSettings, updateSettings } from '../settings'
import { ensureDir, errorMessage } from '../util'

export interface FilterListDef {
  id: string
  name: string
  description: string
  url: string
}

/** 검증된 필터 목록 (uBlock/AdGuard 문법 호환 빌드) */
export const FILTER_LISTS: FilterListDef[] = [
  { id: 'adguard-base', name: 'AdGuard Base', description: '광고 차단 기본 목록 (EasyList 포함)', url: 'https://filters.adtidy.org/extension/ublock/filters/2.txt' },
  { id: 'adguard-tracking', name: 'AdGuard Tracking Protection', description: '추적기·분석 스크립트 차단', url: 'https://filters.adtidy.org/extension/ublock/filters/3.txt' },
  { id: 'adguard-social', name: 'AdGuard Social Media', description: '소셜 위젯·공유 버튼 제거', url: 'https://filters.adtidy.org/extension/ublock/filters/4.txt' },
  { id: 'adguard-annoyances', name: 'AdGuard Annoyances', description: '쿠키 안내, 팝업, 앱 설치 배너 등 방해 요소 제거', url: 'https://filters.adtidy.org/extension/ublock/filters/14.txt' },
  { id: 'list-kr', name: 'List-KR', description: '한국어 사이트 전용 필터 (AdGuard·커뮤니티 관리)', url: 'https://cdn.jsdelivr.net/gh/List-KR/List-KR@latest/filter-uBlockOrigin.txt' },
  { id: 'easylist', name: 'EasyList', description: '범용 광고 차단 목록', url: 'https://easylist.to/easylist/easylist.txt' },
  { id: 'easyprivacy', name: 'EasyPrivacy', description: '범용 추적 차단 목록', url: 'https://easylist.to/easylist/easyprivacy.txt' },
  { id: 'ublock-filters', name: 'uBlock filters', description: 'uBlock Origin 기본 보강 규칙', url: 'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/filters.txt' },
  { id: 'ublock-unbreak', name: 'uBlock unbreak', description: '차단으로 깨지는 사이트 복구 규칙', url: 'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/unbreak.txt' }
]

const UPDATE_INTERVAL = 24 * 60 * 60 * 1000
const CHECK_INTERVAL = 60 * 60 * 1000
const DOH_SERVER = 'https://dns.adguard-dns.com/dns-query'
const FILTER = { urls: ['http://*/*', 'https://*/*'] }
const ENGINE_CONFIG: Record<string, boolean> = {
  enableCompression: false,
  enableOptimizations: true,
  loadNetworkFilters: true,
  loadCosmeticFilters: true,
  loadExtendedSelectors: true,
  enableMutationObserver: true,
  guessRequestTypeFromUrl: true
}

interface CacheMeta {
  key: string
  updatedAt: number
  ruleCount: number
}

function fetchWithTimeout(url: string): Promise<Response> {
  return fetch(url, { signal: AbortSignal.timeout(60_000), redirect: 'follow' })
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return ''
  }
}

/**
 * 내장 브라우저 세션용 광고·추적 차단기.
 * 이벤트: 'stats' (차단 수 변경), 'status' (설정/업데이트 상태 변경)
 */
export class AdBlocker extends EventEmitter {
  private blocker: ElectronBlocker | null = null
  private counts = new Map<number, number>()
  private totalBlocked = 0
  private updating = false
  private error: string | null = null
  private updatedAt = 0
  private ruleCount = 0
  private statsTimer: NodeJS.Timeout | null = null
  private checkTimer: NodeJS.Timeout | null = null
  private preloadId: string | null = null
  private pendingRebuild = false

  constructor(private readonly session: Session) {
    super()
  }

  private dir(): string {
    return path.join(app.getPath('userData'), 'adblock')
  }

  private listCachePath(id: string): string {
    return path.join(this.dir(), 'lists', `${id}.txt`)
  }

  private settings(): AdblockSettings {
    return getSettings().adblock
  }

  get enabled(): boolean {
    return this.settings().enabled && this.blocker !== null
  }

  // ---------- 초기화 ----------

  async init(): Promise<void> {
    ipcMain.handle('@ghostery/adblocker/inject-cosmetic-filters', (event, url: string, msg?: unknown) => this.injectCosmetics(event, url, msg))
    ipcMain.handle('@ghostery/adblocker/is-mutation-observer-enabled', (event) =>
      this.blocker ? this.blocker.onIsMutationObserverEnabled(event) : Promise.resolve(false)
    )
    this.registerPreload()
    this.applyDoh()
    await this.loadCache()
    if (!this.blocker || Date.now() - this.updatedAt > UPDATE_INTERVAL) void this.rebuild(true)
    this.checkTimer = setInterval(() => {
      if (Date.now() - this.updatedAt > UPDATE_INTERVAL) void this.rebuild(true)
    }, CHECK_INTERVAL)
  }

  private registerPreload(): void {
    try {
      const preloadPath = require.resolve('@ghostery/adblocker-electron-preload')
      this.preloadId = this.session.registerPreloadScript({ type: 'frame', filePath: preloadPath })
    } catch (e) {
      this.error = `코스메틱 필터 preload 등록 실패: ${errorMessage(e)}`
    }
  }

  destroy(): void {
    if (this.checkTimer) clearInterval(this.checkTimer)
    if (this.statsTimer) clearTimeout(this.statsTimer)
    if (this.preloadId) {
      try {
        this.session.unregisterPreloadScript(this.preloadId)
      } catch {
        /* ignore */
      }
    }
    ipcMain.removeHandler('@ghostery/adblocker/inject-cosmetic-filters')
    ipcMain.removeHandler('@ghostery/adblocker/is-mutation-observer-enabled')
  }

  // ---------- 캐시 ----------

  private cacheKey(): string {
    const s = this.settings()
    const lists = [...s.lists].sort().join(',')
    const custom = crypto.createHash('sha1').update(s.customRules).digest('hex')
    return `v2|${lists}|${custom}`
  }

  /** 마지막 캐시 로딩에 걸린 시간(ms). 진단용. */
  cacheLoadMs = -1

  private async loadCache(): Promise<void> {
    const t0 = Date.now()
    try {
      const meta = JSON.parse(await fs.readFile(path.join(this.dir(), 'meta.json'), 'utf8')) as CacheMeta
      if (meta.key !== this.cacheKey()) return
      const buf = await fs.readFile(path.join(this.dir(), 'engine.bin'))
      this.blocker = ElectronBlocker.deserialize(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength))
      this.updatedAt = meta.updatedAt
      this.ruleCount = meta.ruleCount
      this.cacheLoadMs = Date.now() - t0
    } catch {
      this.blocker = null
    }
  }

  /** 새 창(팝업) 주소가 알려진 광고·추적 도메인인지 검사한다. 차단기가 꺼져 있으면 항상 false. */
  testPopup(url: string, sourceUrl: string): boolean {
    if (!this.enabled || !this.blocker) return false
    if (this.isAllowedHost(hostOf(sourceUrl))) return false
    try {
      // 타입 없는 일반 규칙과 3p 규칙까지 걸리도록 'other' 로 조회한다
      const { match } = this.blocker.match(Request.fromRawDetails({ url, sourceUrl, type: 'other' }))
      return match
    } catch {
      return false
    }
  }

  /** 진단용: 주어진 요청이 차단되는지 엔진에 직접 물어본다. */
  test(url: string, type: string, sourceUrl = 'https://example.com/'): { blocked: boolean; redirect: boolean; filter?: string } {
    if (!this.blocker) return { blocked: false, redirect: false }
    const { match, redirect, filter } = this.blocker.match(
      Request.fromRawDetails({ url, sourceUrl, type: type as Parameters<typeof Request.fromRawDetails>[0]['type'] })
    )
    return { blocked: match, redirect: !!redirect, filter: filter?.toString() }
  }

  private async saveCache(buffer: Uint8Array): Promise<void> {
    await ensureDir(this.dir())
    await fs.writeFile(path.join(this.dir(), 'engine.bin'), buffer)
    const meta: CacheMeta = { key: this.cacheKey(), updatedAt: this.updatedAt, ruleCount: this.ruleCount }
    await fs.writeFile(path.join(this.dir(), 'meta.json'), JSON.stringify(meta))
  }

  private async listText(def: FilterListDef, refresh: boolean): Promise<{ text: string; error?: string }> {
    const cached = this.listCachePath(def.id)
    let stale = true
    if (existsSync(cached)) {
      try {
        stale = Date.now() - (await fs.stat(cached)).mtimeMs > UPDATE_INTERVAL
      } catch {
        stale = true
      }
    }
    if (!refresh && existsSync(cached) && !stale) return { text: await fs.readFile(cached, 'utf8') }
    try {
      const res = await fetchWithTimeout(def.url)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const text = await res.text()
      if (!text.trim()) throw new Error('빈 응답')
      await ensureDir(path.dirname(cached))
      await fs.writeFile(cached, text, 'utf8')
      return { text }
    } catch (e) {
      if (existsSync(cached)) return { text: await fs.readFile(cached, 'utf8'), error: `${def.name}: ${errorMessage(e)} (캐시 사용)` }
      return { text: '', error: `${def.name}: ${errorMessage(e)}` }
    }
  }

  /** 선택된 목록을 (필요하면 새로 받아) 파싱해 엔진을 교체한다. */
  async rebuild(refresh: boolean): Promise<void> {
    if (this.updating) {
      this.pendingRebuild = true
      return
    }
    this.updating = true
    this.error = null
    this.emitStatus()
    try {
      const s = this.settings()
      const selected = FILTER_LISTS.filter((l) => s.lists.includes(l.id))
      const results = await Promise.all(selected.map((l) => this.listText(l, refresh)))
      const errors = results.map((r) => r.error).filter((x): x is string => !!x)
      const texts = results.map((r) => r.text).filter((t) => t.trim().length > 0)
      if (s.customRules.trim()) texts.push(s.customRules)
      if (!texts.length && selected.length) throw new Error(errors.join('; ') || '필터 목록을 받지 못했습니다')

      let resources: string | null = null
      try {
        resources = await fetchResources(fetchWithTimeout as unknown as typeof fetch)
      } catch {
        resources = null
      }
      const ruleCount = texts.reduce((n, t) => n + t.split('\n').filter((l) => l.trim() && !l.startsWith('!') && !l.startsWith('[')).length, 0)
      const buffer = await this.parseInWorker(texts, resources)
      this.blocker = ElectronBlocker.deserialize(buffer)
      this.updatedAt = Date.now()
      this.ruleCount = ruleCount
      await this.saveCache(buffer)
      if (errors.length) this.error = `일부 목록 문제: ${errors.join(', ')}`
    } catch (e) {
      this.error = errorMessage(e)
    } finally {
      this.updating = false
      this.emitStatus()
      if (this.pendingRebuild) {
        this.pendingRebuild = false
        void this.rebuild(false)
      }
    }
  }

  private parseInWorker(texts: string[], resources: string | null): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
      const worker = new Worker(path.join(__dirname, 'adblock-worker.js'), {
        workerData: { texts, resources, config: ENGINE_CONFIG }
      })
      const timer = setTimeout(() => {
        void worker.terminate()
        reject(new Error('필터 파싱 시간이 초과되었습니다'))
      }, 120_000)
      worker.once('message', (msg: { ok: boolean; buffer?: Uint8Array; error?: string }) => {
        clearTimeout(timer)
        if (msg.ok && msg.buffer) resolve(msg.buffer instanceof Uint8Array ? msg.buffer : new Uint8Array(msg.buffer))
        else reject(new Error(msg.error ?? '필터 파싱 실패'))
      })
      worker.once('error', (e) => {
        clearTimeout(timer)
        reject(e)
      })
    })
  }

  // ---------- 요청 처리 ----------

  private isAllowedHost(host: string): boolean {
    if (!host) return false
    return this.settings().allowlist.some((d) => host === d || host.endsWith(`.${d}`))
  }

  private pageHostFor(details: { webContentsId?: number; referrer?: string }): string {
    if (details.webContentsId) {
      const wc = webContents.fromId(details.webContentsId)
      if (wc && !wc.isDestroyed()) {
        const h = hostOf(wc.getURL())
        if (h) return h
      }
    }
    return hostOf(details.referrer ?? '')
  }

  onBeforeRequest(details: Electron.OnBeforeRequestListenerDetails, callback: (r: Electron.CallbackResponse) => void): void {
    if (details.resourceType === 'mainFrame') {
      if (details.webContentsId !== undefined && this.counts.has(details.webContentsId)) {
        this.counts.delete(details.webContentsId)
        this.scheduleStats()
      }
      callback({})
      return
    }
    if (!this.enabled || !this.blocker || this.isAllowedHost(this.pageHostFor(details))) {
      callback({})
      return
    }
    try {
      this.blocker.onBeforeRequest(details, (r) => {
        if (r.cancel || r.redirectURL) this.bump(details.webContentsId)
        callback(r)
      })
    } catch {
      callback({})
    }
  }

  onHeadersReceived(details: Electron.OnHeadersReceivedListenerDetails, callback: (r: Electron.HeadersReceivedResponse) => void): void {
    if (!this.enabled || !this.blocker || this.isAllowedHost(details.resourceType === 'mainFrame' ? hostOf(details.url) : this.pageHostFor(details))) {
      callback({ responseHeaders: details.responseHeaders })
      return
    }
    try {
      this.blocker.onHeadersReceived(details, callback)
    } catch {
      callback({ responseHeaders: details.responseHeaders })
    }
  }

  private injectCosmetics(event: IpcMainInvokeEvent, url: string, msg: unknown): Promise<void> {
    if (!this.enabled || !this.blocker || this.isAllowedHost(hostOf(url))) return Promise.resolve()
    return this.blocker.onInjectCosmeticFilters(event, url, msg as Parameters<ElectronBlocker['onInjectCosmeticFilters']>[2])
  }

  private bump(tabId: number | undefined): void {
    this.totalBlocked++
    if (tabId !== undefined) this.counts.set(tabId, (this.counts.get(tabId) ?? 0) + 1)
    this.scheduleStats()
  }

  private scheduleStats(): void {
    if (this.statsTimer) return
    this.statsTimer = setTimeout(() => {
      this.statsTimer = null
      this.emit('stats')
    }, 300)
  }

  countFor(tabId: number): number {
    return this.counts.get(tabId) ?? 0
  }

  resetTab(tabId: number): void {
    this.counts.delete(tabId)
  }

  tabStats(tabId: number): AdblockTabStats {
    const wc = webContents.fromId(tabId)
    const host = wc && !wc.isDestroyed() ? hostOf(wc.getURL()) : ''
    return { tabId, host, blocked: this.countFor(tabId), allowed: this.isAllowedHost(host) }
  }

  // ---------- 설정 ----------

  private emitStatus(): void {
    this.emit('status', this.status())
  }

  async status(): Promise<AdblockStatus> {
    const s = this.settings()
    const lists: AdblockListInfo[] = []
    for (const def of FILTER_LISTS) {
      let cachedAt: number | null = null
      try {
        cachedAt = (await fs.stat(this.listCachePath(def.id))).mtimeMs
      } catch {
        cachedAt = null
      }
      lists.push({ id: def.id, name: def.name, description: def.description, selected: s.lists.includes(def.id), cachedAt })
    }
    return {
      enabled: s.enabled,
      doh: s.doh,
      ready: this.blocker !== null,
      updating: this.updating,
      updatedAt: this.updatedAt,
      error: this.error,
      lists,
      customRules: s.customRules,
      allowlist: s.allowlist,
      totalBlocked: this.totalBlocked,
      ruleCount: this.ruleCount
    }
  }

  setEnabled(enabled: boolean): void {
    updateSettings({ adblock: { ...this.settings(), enabled } })
    this.emitStatus()
  }

  setDoh(doh: boolean): void {
    updateSettings({ adblock: { ...this.settings(), doh } })
    this.applyDoh()
    this.emitStatus()
  }

  private applyDoh(): void {
    try {
      if (this.settings().doh) app.configureHostResolver({ secureDnsMode: 'secure', secureDnsServers: [DOH_SERVER] })
      else app.configureHostResolver({ secureDnsMode: 'automatic', secureDnsServers: [] })
    } catch (e) {
      this.error = `DNS 설정 실패: ${errorMessage(e)}`
    }
  }

  async setLists(ids: string[]): Promise<void> {
    const valid = ids.filter((id) => FILTER_LISTS.some((l) => l.id === id))
    updateSettings({ adblock: { ...this.settings(), lists: valid } })
    await this.rebuild(false)
  }

  async setCustomRules(text: string): Promise<void> {
    updateSettings({ adblock: { ...this.settings(), customRules: text } })
    await this.rebuild(false)
  }

  setAllowed(host: string, allowed: boolean): void {
    const h = host.trim().toLowerCase().replace(/^www\./, '')
    if (!h) return
    const list = new Set(this.settings().allowlist)
    if (allowed) list.add(h)
    else {
      list.delete(h)
      list.delete(`www.${h}`)
    }
    updateSettings({ adblock: { ...this.settings(), allowlist: [...list] } })
    this.emitStatus()
  }

  async update(): Promise<void> {
    await this.rebuild(true)
  }
}
