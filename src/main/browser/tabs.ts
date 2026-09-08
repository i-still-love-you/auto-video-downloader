import { EventEmitter } from 'node:events'
import { promises as fs, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { app, BrowserWindow, Menu, WebContentsView, clipboard, type Session, type WebContents } from 'electron'
import type { BrowserState, Rect, TabState } from '@shared/types'
import { SEARCH_ENGINES } from '@shared/types'
import { getSettings } from '../settings'
import { addHistory, updateHistoryTitle } from '../storage/db'
import type { Sniffer } from './sniffer'
import type { AdBlocker } from './adblock'

interface NavEntry {
  url: string
  title: string
}

interface SavedTab {
  url: string
  title: string
  entries: NavEntry[]
  index: number
}

interface SessionData {
  tabs: SavedTab[]
  activeIndex: number
}

interface Tab {
  id: number
  view: WebContentsView
  state: TabState
  blank: boolean
  /** 세션 복구로 만들어졌지만 아직 로드하지 않은 탭 (활성화될 때 로드) */
  pending: SavedTab | null
}

const MAX_CLOSED = 20
const MAX_ENTRIES = 50

export function resolveInput(input: string, engineId: string): string {
  const t = input.trim()
  if (!t) return ''
  if (/^[a-z][a-z0-9+.-]*:/i.test(t) && !/^[a-z0-9-]+\.[a-z]+:\d+/i.test(t)) return t
  if (/^localhost(:\d+)?(\/|$)/i.test(t) || /^(\d{1,3}\.){3}\d{1,3}(:\d+)?(\/|$)/.test(t)) return `http://${t}`
  if (!/\s/.test(t) && /^[\w-]+(\.[\w-]+)+(:\d+)?(\/.*)?$/i.test(t)) return `https://${t}`
  const engine = SEARCH_ENGINES.find((e) => e.id === engineId) ?? SEARCH_ENGINES[0]
  return engine.url.replace('%s', encodeURIComponent(t))
}

/**
 * WebContentsView 기반 탭 관리자. 열린 탭과 각 탭의 탐색 기록을 세션 파일에 저장해 다음 실행 때 복구한다.
 * 이벤트: 'state' (BrowserState), 'focusAddress', 'bookmark', 'downloadUrl' (url, pageUrl)
 */
export class TabManager extends EventEmitter {
  private tabs = new Map<number, Tab>()
  private order: number[] = []
  private activeId: number | null = null
  private bounds: Rect = { x: 0, y: 0, width: 0, height: 0 }
  private visible = true
  private fullscreenTab: number | null = null
  private stateTimer: NodeJS.Immediate | null = null
  private sessionTimer: NodeJS.Timeout | null = null
  private closedTabs: SavedTab[] = []
  private destroyed = false

  constructor(
    private readonly win: BrowserWindow,
    private readonly session: Session,
    private readonly sniffer: Sniffer,
    private readonly adblock?: AdBlocker
  ) {
    super()
    sniffer.on('changed', () => this.emitState())
    adblock?.on('stats', () => this.emitState())
    win.on('resize', () => this.layout())
    win.on('close', () => this.saveSessionSync())
  }

  hasTab(id: number): boolean {
    return this.tabs.has(id)
  }

  get activeTabId(): number | null {
    return this.activeId
  }

  getState(): BrowserState {
    return {
      tabs: this.order.map((id) => {
        const t = this.tabs.get(id)!
        return { ...t.state, detectedCount: this.sniffer.countFor(id), blockedCount: this.adblock?.countFor(id) ?? 0 }
      }),
      activeTabId: this.activeId
    }
  }

  // ---------- 탭 생성 ----------

  private createTab(insertAfter?: number): Tab {
    const view = new WebContentsView({
      webPreferences: {
        session: this.session,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        spellcheck: false
      }
    })
    const wc = view.webContents
    const id = wc.id
    const tab: Tab = {
      id,
      view,
      blank: true,
      pending: null,
      state: { id, url: '', title: '새 탭', favicon: null, loading: false, canGoBack: false, canGoForward: false, detectedCount: 0, blockedCount: 0 }
    }
    this.tabs.set(id, tab)
    const at = insertAfter !== undefined ? this.order.indexOf(insertAfter) : -1
    if (at >= 0) this.order.splice(at + 1, 0, id)
    else this.order.push(id)
    this.win.contentView.addChildView(view)
    view.setVisible(false)
    this.wire(tab)
    return tab
  }

  newTab(url?: string, activate = true, insertAfter?: number): number {
    const tab = this.createTab(insertAfter)
    if (activate || this.activeId === null) this.activeId = tab.id
    this.layout()
    this.emitState()
    const target = url ?? getSettings().homeUrl
    if (target) this.navigate(tab.id, target)
    return tab.id
  }

  private addSavedTab(saved: SavedTab, activate: boolean, insertAfter?: number): number {
    const tab = this.createTab(insertAfter)
    tab.blank = false
    tab.pending = saved
    tab.state.url = saved.url
    tab.state.title = saved.title || saved.url
    if (activate || this.activeId === null) {
      this.activeId = tab.id
      this.loadPending(tab)
    }
    this.layout()
    this.emitState()
    return tab.id
  }

  private loadPending(tab: Tab): void {
    const saved = tab.pending
    if (!saved) return
    tab.pending = null
    const wc = tab.view.webContents
    const nav = wc.navigationHistory as unknown as { restore?: (o: { entries: NavEntry[]; index?: number }) => Promise<void> }
    if (typeof nav.restore === 'function' && saved.entries.length) {
      const index = Math.min(Math.max(0, saved.index), saved.entries.length - 1)
      nav.restore({ entries: saved.entries, index }).catch(() => {
        void wc.loadURL(saved.url).catch(() => undefined)
      })
      return
    }
    void wc.loadURL(saved.url).catch(() => undefined)
  }

  private snapshot(tab: Tab): SavedTab | null {
    if (tab.pending) return tab.pending
    if (tab.blank || !tab.state.url) return null
    const wc = tab.view.webContents
    if (wc.isDestroyed()) return null
    let entries: NavEntry[] = []
    let index = 0
    try {
      const all = wc.navigationHistory.getAllEntries()
      index = wc.navigationHistory.getActiveIndex()
      entries = all.map((e) => ({ url: e.url, title: e.title }))
      if (entries.length > MAX_ENTRIES) {
        const start = Math.max(0, index - MAX_ENTRIES + 1)
        entries = entries.slice(start, start + MAX_ENTRIES)
        index -= start
      }
    } catch {
      entries = []
    }
    if (!entries.length) entries = [{ url: tab.state.url, title: tab.state.title }]
    return { url: tab.state.url, title: tab.state.title, entries, index: Math.max(0, Math.min(index, entries.length - 1)) }
  }

  // ---------- 세션 저장/복구 ----------

  private sessionPath(): string {
    return path.join(app.getPath('userData'), 'session.json')
  }

  private sessionData(): SessionData {
    const tabs: SavedTab[] = []
    let activeIndex = 0
    for (const id of this.order) {
      const tab = this.tabs.get(id)
      if (!tab) continue
      const snap = this.snapshot(tab)
      if (!snap) continue
      if (id === this.activeId) activeIndex = tabs.length
      tabs.push(snap)
    }
    return { tabs, activeIndex }
  }

  private scheduleSessionSave(): void {
    if (this.destroyed || this.sessionTimer) return
    this.sessionTimer = setTimeout(() => {
      this.sessionTimer = null
      void this.saveSession()
    }, 1000)
  }

  private async saveSession(): Promise<void> {
    if (this.destroyed) return
    try {
      await fs.mkdir(path.dirname(this.sessionPath()), { recursive: true })
      const tmp = `${this.sessionPath()}.tmp`
      await fs.writeFile(tmp, JSON.stringify(this.sessionData()), 'utf8')
      await fs.rename(tmp, this.sessionPath())
    } catch {
      /* ignore */
    }
  }

  saveSessionSync(): void {
    if (this.destroyed) return
    try {
      mkdirSync(path.dirname(this.sessionPath()), { recursive: true })
      writeFileSync(this.sessionPath(), JSON.stringify(this.sessionData()), 'utf8')
    } catch {
      /* ignore */
    }
  }

  /** 저장된 세션의 탭을 복구한다. 활성 탭만 즉시 로드하고 나머지는 선택할 때 로드한다. */
  async restoreSession(): Promise<number> {
    let data: SessionData
    try {
      data = JSON.parse(await fs.readFile(this.sessionPath(), 'utf8')) as SessionData
    } catch {
      return 0
    }
    const tabs = (data.tabs ?? []).filter((t) => t && typeof t.url === 'string' && /^https?:/i.test(t.url))
    if (!tabs.length) return 0
    const activeIndex = Math.min(Math.max(0, data.activeIndex ?? 0), tabs.length - 1)
    tabs.forEach((t, i) => this.addSavedTab({ ...t, entries: Array.isArray(t.entries) ? t.entries : [] }, i === activeIndex))
    return tabs.length
  }

  // ---------- 이벤트 연결 ----------

  private wire(tab: Tab): void {
    const wc = tab.view.webContents
    const { state } = tab
    const sync = (): void => {
      if (wc.isDestroyed()) return
      const nav = wc.navigationHistory
      state.canGoBack = nav ? nav.canGoBack() : false
      state.canGoForward = nav ? nav.canGoForward() : false
      this.emitState()
    }

    wc.on('did-start-loading', () => {
      state.loading = true
      sync()
    })
    wc.on('did-stop-loading', () => {
      state.loading = false
      sync()
      this.scheduleSessionSave()
    })
    wc.on('did-navigate', (_e, url) => {
      tab.blank = false
      state.url = url
      state.favicon = null
      state.title = wc.getTitle() || url
      this.sniffer.clearTab(tab.id)
      addHistory(url, state.title)
      this.layout()
      sync()
      this.scheduleSessionSave()
    })
    wc.on('did-navigate-in-page', (_e, url, isMainFrame) => {
      if (!isMainFrame) return
      state.url = url
      addHistory(url, wc.getTitle())
      sync()
      this.scheduleSessionSave()
    })
    wc.on('page-title-updated', (_e, title) => {
      state.title = title
      updateHistoryTitle(state.url, title)
      this.emitState()
      this.scheduleSessionSave()
    })
    wc.on('page-favicon-updated', (_e, favicons) => {
      state.favicon = favicons[0] ?? null
      this.emitState()
    })
    wc.on('did-fail-load', (_e, code, desc, _url, isMainFrame) => {
      if (isMainFrame && code !== -3) {
        state.title = `페이지를 열 수 없습니다 (${desc || code})`
        this.emitState()
      }
    })
    wc.setWindowOpenHandler(({ url }) => {
      if (/^https?:/i.test(url)) this.newTab(url, true, tab.id)
      return { action: 'deny' }
    })
    wc.on('before-input-event', (event, input) => {
      if (this.handleShortcut(tab, input)) event.preventDefault()
    })
    wc.on('context-menu', (_e, params) => this.showContextMenu(tab, params))
    wc.on('enter-html-full-screen', () => {
      this.fullscreenTab = tab.id
      if (!this.win.isFullScreen()) this.win.setFullScreen(true)
      this.layout()
    })
    wc.on('leave-html-full-screen', () => {
      if (this.fullscreenTab === tab.id) {
        this.fullscreenTab = null
        if (this.win.isFullScreen()) this.win.setFullScreen(false)
        this.layout()
      }
    })
    wc.on('destroyed', () => this.forget(tab.id))
  }

  private handleShortcut(tab: Tab, input: Electron.Input): boolean {
    if (input.type !== 'keyDown') return false
    const mod = input.control || input.meta
    const key = input.key.toLowerCase()
    if (mod && !input.shift && key === 't') {
      this.newTab(undefined, true)
      this.emit('focusAddress')
      return true
    }
    if (mod && input.shift && key === 't') {
      this.reopenClosedTab()
      return true
    }
    if (mod && key === 'w') {
      this.closeTab(tab.id)
      return true
    }
    if (mod && key === 'l') {
      this.emit('focusAddress')
      return true
    }
    if (mod && key === 'd') {
      this.emit('bookmark', tab.id)
      return true
    }
    if ((mod && key === 'r') || input.key === 'F5') {
      tab.view.webContents.reload()
      return true
    }
    if (mod && !input.shift && !input.alt && /^[1-9]$/.test(input.key)) {
      this.activateIndex(Number(input.key))
      return true
    }
    if (input.alt && input.key === 'ArrowLeft') {
      this.goBack(tab.id)
      return true
    }
    if (input.alt && input.key === 'ArrowRight') {
      this.goForward(tab.id)
      return true
    }
    if (input.key === 'F12' || (mod && input.shift && key === 'i')) {
      tab.view.webContents.toggleDevTools()
      return true
    }
    if (mod && input.key === 'Tab') {
      this.cycle(input.shift ? -1 : 1)
      return true
    }
    if (input.key === 'Escape' && tab.state.loading) {
      tab.view.webContents.stop()
      return true
    }
    return false
  }

  private showContextMenu(tab: Tab, params: Electron.ContextMenuParams): void {
    const wc = tab.view.webContents
    const items: Electron.MenuItemConstructorOptions[] = []
    if (params.mediaType === 'video' || params.mediaType === 'audio') {
      items.push(
        { label: '이 동영상 다운로드', click: () => this.emit('downloadUrl', params.srcURL, wc.getURL()) },
        { label: '동영상 주소 복사', click: () => clipboard.writeText(params.srcURL) },
        { type: 'separator' }
      )
    }
    if (params.linkURL) {
      items.push(
        { label: '새 탭에서 링크 열기', click: () => this.newTab(params.linkURL, false, tab.id) },
        { label: '링크 주소 복사', click: () => clipboard.writeText(params.linkURL) },
        { label: '링크로 다운로드 시도', click: () => this.emit('downloadUrl', params.linkURL, wc.getURL()) },
        { type: 'separator' }
      )
    }
    if (params.mediaType === 'image' && params.srcURL) {
      items.push({ label: '이미지 주소 복사', click: () => clipboard.writeText(params.srcURL) }, { type: 'separator' })
    }
    if (params.isEditable) {
      items.push(
        { label: '실행 취소', role: 'undo' },
        { label: '다시 실행', role: 'redo' },
        { type: 'separator' },
        { label: '잘라내기', role: 'cut' },
        { label: '복사', role: 'copy' },
        { label: '붙여넣기', role: 'paste' },
        { label: '전체 선택', role: 'selectAll' },
        { type: 'separator' }
      )
    } else if (params.selectionText) {
      items.push({ label: '복사', role: 'copy' }, { type: 'separator' })
    }
    items.push(
      { label: '뒤로', enabled: tab.state.canGoBack, click: () => this.goBack(tab.id) },
      { label: '앞으로', enabled: tab.state.canGoForward, click: () => this.goForward(tab.id) },
      { label: '새로고침', click: () => wc.reload() },
      { type: 'separator' },
      { label: '현재 페이지 주소로 다운로드 시도', click: () => this.emit('downloadUrl', wc.getURL(), wc.getURL()) },
      { label: '검사', click: () => wc.inspectElement(params.x, params.y) }
    )
    Menu.buildFromTemplate(items).popup({ window: this.win })
  }

  /** 탭 스트립에서 우클릭했을 때의 네이티브 메뉴 */
  showTabMenu(id: number): void {
    const tab = this.tabs.get(id)
    if (!tab) return
    const idx = this.order.indexOf(id)
    const others = this.order.length - 1
    const right = this.order.length - idx - 1
    const items: Electron.MenuItemConstructorOptions[] = [
      { label: '새 탭', accelerator: 'CmdOrCtrl+T', click: () => this.newTab(undefined, true, id) },
      { label: '새로고침', enabled: !tab.blank, click: () => this.reload(id) },
      { label: '탭 복제', enabled: !tab.blank, click: () => this.duplicateTab(id) },
      { type: 'separator' },
      { label: '다른 탭 모두 닫기', enabled: others > 0, click: () => this.closeOtherTabs(id) },
      { label: '오른쪽 탭 모두 닫기', enabled: right > 0, click: () => this.closeTabsToRight(id) },
      { label: '탭 닫기', accelerator: 'CmdOrCtrl+W', click: () => this.closeTab(id) },
      { type: 'separator' },
      { label: '닫은 탭 다시 열기', accelerator: 'CmdOrCtrl+Shift+T', enabled: this.closedTabs.length > 0, click: () => this.reopenClosedTab() }
    ]
    Menu.buildFromTemplate(items).popup({ window: this.win })
  }

  private cycle(dir: number): void {
    if (this.activeId === null || this.order.length < 2) return
    const idx = this.order.indexOf(this.activeId)
    const next = this.order[(idx + dir + this.order.length) % this.order.length]
    this.activate(next)
  }

  /** Ctrl+1~8 은 n번째 탭, Ctrl+9 는 마지막 탭 */
  activateIndex(n: number): void {
    if (!this.order.length) return
    const idx = n >= 9 ? this.order.length - 1 : n - 1
    const id = this.order[idx]
    if (id !== undefined) this.activate(id)
  }

  // ---------- 탭 닫기 ----------

  closeTab(id: number): void {
    const tab = this.tabs.get(id)
    if (!tab) return
    const snap = this.snapshot(tab)
    if (snap) {
      this.closedTabs.push(snap)
      if (this.closedTabs.length > MAX_CLOSED) this.closedTabs.shift()
    }
    const wasActive = this.activeId === id
    const idx = this.order.indexOf(id)
    this.forget(id)
    try {
      this.win.contentView.removeChildView(tab.view)
    } catch {
      /* ignore */
    }
    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close()
    if (wasActive) {
      const next = this.order[Math.min(idx, this.order.length - 1)] ?? null
      this.activeId = next
      const nextTab = next !== null ? this.tabs.get(next) : undefined
      if (nextTab?.pending) this.loadPending(nextTab)
    }
    if (this.order.length === 0 && !this.destroyed) this.newTab()
    this.layout()
    this.emitState()
    this.scheduleSessionSave()
  }

  closeOtherTabs(id: number): void {
    if (!this.tabs.has(id)) return
    for (const other of [...this.order]) if (other !== id) this.closeTab(other)
    this.activate(id)
  }

  closeTabsToRight(id: number): void {
    const idx = this.order.indexOf(id)
    if (idx < 0) return
    for (const other of this.order.slice(idx + 1)) this.closeTab(other)
    if (!this.tabs.has(this.activeId ?? -1)) this.activate(id)
  }

  duplicateTab(id: number): number | null {
    const tab = this.tabs.get(id)
    if (!tab) return null
    const snap = this.snapshot(tab)
    if (!snap) return this.newTab(undefined, true, id)
    return this.addSavedTab(snap, true, id)
  }

  reopenClosedTab(): number | null {
    const snap = this.closedTabs.pop()
    if (!snap) return null
    return this.addSavedTab(snap, true, this.activeId ?? undefined)
  }

  private forget(id: number): void {
    if (!this.tabs.has(id)) return
    this.tabs.delete(id)
    this.order = this.order.filter((x) => x !== id)
    this.sniffer.removeTab(id)
    this.adblock?.resetTab(id)
    if (this.activeId === id) this.activeId = this.order[0] ?? null
    if (this.fullscreenTab === id) {
      this.fullscreenTab = null
      if (this.win.isFullScreen()) this.win.setFullScreen(false)
    }
    this.emitState()
  }

  // ---------- 탐색 ----------

  activate(id: number): void {
    const tab = this.tabs.get(id)
    if (!tab) return
    this.activeId = id
    if (tab.pending) this.loadPending(tab)
    this.layout()
    this.emitState()
    this.scheduleSessionSave()
    if (!tab.blank) tab.view.webContents.focus()
  }

  navigate(id: number, input: string): void {
    const tab = this.tabs.get(id)
    if (!tab) return
    const url = resolveInput(input, getSettings().searchEngineId)
    if (!url) return
    tab.blank = false
    tab.pending = null
    tab.state.url = url
    tab.state.title = url
    this.layout()
    this.emitState()
    void tab.view.webContents.loadURL(url).catch(() => undefined)
  }

  goBack(id: number): void {
    const wc = this.wc(id)
    if (wc?.navigationHistory.canGoBack()) wc.navigationHistory.goBack()
  }

  goForward(id: number): void {
    const wc = this.wc(id)
    if (wc?.navigationHistory.canGoForward()) wc.navigationHistory.goForward()
  }

  reload(id: number): void {
    const tab = this.tabs.get(id)
    if (tab?.pending) {
      this.loadPending(tab)
      return
    }
    this.wc(id)?.reload()
  }

  stop(id: number): void {
    this.wc(id)?.stop()
  }

  private wc(id: number): WebContents | undefined {
    const t = this.tabs.get(id)
    if (!t || t.view.webContents.isDestroyed()) return undefined
    return t.view.webContents
  }

  activeWebContents(): WebContents | undefined {
    return this.activeId === null ? undefined : this.wc(this.activeId)
  }

  // ---------- 배치 ----------

  setBounds(rect: Rect): void {
    this.bounds = {
      x: Math.max(0, Math.round(rect.x)),
      y: Math.max(0, Math.round(rect.y)),
      width: Math.max(0, Math.round(rect.width)),
      height: Math.max(0, Math.round(rect.height))
    }
    this.layout()
  }

  setVisible(visible: boolean): void {
    this.visible = visible
    this.layout()
  }

  private layout(): void {
    if (this.destroyed) return
    for (const tab of this.tabs.values()) {
      const isFull = this.fullscreenTab === tab.id
      const show = isFull || (this.visible && tab.id === this.activeId && !tab.blank)
      if (show) {
        if (isFull) {
          const cb = this.win.getContentBounds()
          tab.view.setBounds({ x: 0, y: 0, width: cb.width, height: cb.height })
        } else {
          tab.view.setBounds(this.bounds)
        }
      }
      tab.view.setVisible(show)
    }
  }

  private emitState(): void {
    if (this.destroyed || this.stateTimer) return
    this.stateTimer = setImmediate(() => {
      this.stateTimer = null
      if (!this.destroyed) this.emit('state', this.getState())
    })
  }

  destroy(): void {
    if (this.sessionTimer) clearTimeout(this.sessionTimer)
    this.destroyed = true
    for (const tab of this.tabs.values()) {
      try {
        this.win.contentView.removeChildView(tab.view)
        if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close()
      } catch {
        /* ignore */
      }
    }
    this.tabs.clear()
    this.order = []
  }
}
