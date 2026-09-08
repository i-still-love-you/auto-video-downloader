import { EventEmitter } from 'node:events'
import { BrowserWindow, Menu, WebContentsView, clipboard, type Session, type WebContents } from 'electron'
import type { BrowserState, Rect, TabState } from '@shared/types'
import { SEARCH_ENGINES } from '@shared/types'
import { getSettings } from '../settings'
import { addHistory, updateHistoryTitle } from '../storage/db'
import type { Sniffer } from './sniffer'

interface Tab {
  id: number
  view: WebContentsView
  state: TabState
  blank: boolean
}

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
 * WebContentsView 기반 탭 관리자.
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
  private destroyed = false

  constructor(
    private readonly win: BrowserWindow,
    private readonly session: Session,
    private readonly sniffer: Sniffer
  ) {
    super()
    sniffer.on('changed', () => this.emitState())
    win.on('resize', () => this.layout())
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
        return { ...t.state, detectedCount: this.sniffer.countFor(id) }
      }),
      activeTabId: this.activeId
    }
  }

  newTab(url?: string, activate = true): number {
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
      state: { id, url: '', title: '새 탭', favicon: null, loading: false, canGoBack: false, canGoForward: false, detectedCount: 0 }
    }
    this.tabs.set(id, tab)
    this.order.push(id)
    this.win.contentView.addChildView(view)
    view.setVisible(false)
    this.wire(tab)
    if (activate || this.activeId === null) this.activeId = id
    this.layout()
    this.emitState()
    const target = url ?? getSettings().homeUrl
    if (target) this.navigate(id, target)
    return id
  }

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
    })
    wc.on('did-navigate-in-page', (_e, url, isMainFrame) => {
      if (!isMainFrame) return
      state.url = url
      addHistory(url, wc.getTitle())
      sync()
    })
    wc.on('page-title-updated', (_e, title) => {
      state.title = title
      updateHistoryTitle(state.url, title)
      this.emitState()
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
      if (/^https?:/i.test(url)) this.newTab(url, true)
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
        { label: '새 탭에서 링크 열기', click: () => this.newTab(params.linkURL, false) },
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

  private cycle(dir: number): void {
    if (this.activeId === null || this.order.length < 2) return
    const idx = this.order.indexOf(this.activeId)
    const next = this.order[(idx + dir + this.order.length) % this.order.length]
    this.activate(next)
  }

  closeTab(id: number): void {
    const tab = this.tabs.get(id)
    if (!tab) return
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
    }
    if (this.order.length === 0 && !this.destroyed) this.newTab()
    this.layout()
    this.emitState()
  }

  private forget(id: number): void {
    if (!this.tabs.has(id)) return
    this.tabs.delete(id)
    this.order = this.order.filter((x) => x !== id)
    this.sniffer.removeTab(id)
    if (this.activeId === id) this.activeId = this.order[0] ?? null
    if (this.fullscreenTab === id) {
      this.fullscreenTab = null
      if (this.win.isFullScreen()) this.win.setFullScreen(false)
    }
    this.emitState()
  }

  activate(id: number): void {
    if (!this.tabs.has(id)) return
    this.activeId = id
    this.layout()
    this.emitState()
    const tab = this.tabs.get(id)!
    if (!tab.blank) tab.view.webContents.focus()
  }

  navigate(id: number, input: string): void {
    const tab = this.tabs.get(id)
    if (!tab) return
    const url = resolveInput(input, getSettings().searchEngineId)
    if (!url) return
    tab.blank = false
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
