import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { IPC } from '@shared/ipc'
import type {
  AdblockStatus,
  AdblockTabStats,
  AnalyzeResult,
  AppNotification,
  BatchJob,
  BatchOptions,
  BatchPreview,
  Bookmark,
  BrowserState,
  DetectedMedia,
  DownloadTask,
  EnqueueRequest,
  FileEntry,
  HistoryEntry,
  NavigateEvent,
  PopupStats,
  Rect,
  Settings,
  ThumbnailCacheInfo,
  ThumbnailResult,
  ToolInstallProgress,
  ToolName,
  ToolStatus,
  UpdateInfo,
  VaultState
} from '@shared/types'
import type { DownloadRecord, DuplicateMatch, DuplicateQuery } from '@shared/dedupe'

function on<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  return ipcRenderer.invoke(channel, ...args).catch((err: Error) => {
    const msg = String(err?.message ?? err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
    throw new Error(msg)
  }) as Promise<T>
}

const api = {
  browser: {
    getState: () => invoke<BrowserState>(IPC.browser.getState),
    newTab: (url?: string) => invoke<number>(IPC.browser.newTab, url),
    closeTab: (id: number) => invoke<void>(IPC.browser.closeTab, id),
    closeOtherTabs: (id: number) => invoke<void>(IPC.browser.closeOtherTabs, id),
    closeTabsToRight: (id: number) => invoke<void>(IPC.browser.closeTabsToRight, id),
    duplicateTab: (id: number) => invoke<number | null>(IPC.browser.duplicateTab, id),
    reopenClosedTab: () => invoke<number | null>(IPC.browser.reopenClosedTab),
    activateIndex: (n: number) => invoke<void>(IPC.browser.activateIndex, n),
    tabMenu: (id: number) => invoke<void>(IPC.browser.tabMenu, id),
    popupStats: (id: number) => invoke<PopupStats>(IPC.browser.popupStats, id),
    openBlockedPopup: (id: number, url: string) => invoke<void>(IPC.browser.openBlockedPopup, id, url),
    setPopupAllowed: (host: string, allowed: boolean) => invoke<void>(IPC.browser.setPopupAllowed, host, allowed),
    setPopupBlockEnabled: (enabled: boolean) => invoke<void>(IPC.browser.setPopupBlockEnabled, enabled),
    onPopupBlocked: (cb: (info: { tabId: number; url: string; reason: string; host: string }) => void) =>
      on<{ tabId: number; url: string; reason: string; host: string }>(IPC.browser.evPopupBlocked, cb),
    activateTab: (id: number) => invoke<void>(IPC.browser.activateTab, id),
    navigate: (id: number, input: string) => invoke<void>(IPC.browser.navigate, id, input),
    goBack: (id: number) => invoke<void>(IPC.browser.goBack, id),
    goForward: (id: number) => invoke<void>(IPC.browser.goForward, id),
    reload: (id: number) => invoke<void>(IPC.browser.reload, id),
    stop: (id: number) => invoke<void>(IPC.browser.stop, id),
    setBounds: (rect: Rect): void => ipcRenderer.send(IPC.browser.setBounds, rect),
    setVisible: (visible: boolean): void => ipcRenderer.send(IPC.browser.setVisible, visible),
    getDetected: (tabId?: number) => invoke<DetectedMedia[]>(IPC.browser.getDetected, tabId),
    clearDetected: (tabId: number) => invoke<void>(IPC.browser.clearDetected, tabId),
    onState: (cb: (s: BrowserState) => void) => on<BrowserState>(IPC.browser.evState, cb),
    onDetected: (cb: (m: DetectedMedia) => void) => on<DetectedMedia>(IPC.browser.evDetected, cb),
    onDetectedUpdated: (cb: (m: DetectedMedia) => void) => on<DetectedMedia>(IPC.browser.evDetectedUpdated, cb)
  },
  history: {
    list: (query?: string, limit?: number) => invoke<HistoryEntry[]>(IPC.history.list, query, limit),
    remove: (id: string) => invoke<void>(IPC.history.remove, id),
    clear: () => invoke<void>(IPC.history.clear)
  },
  bookmarks: {
    list: () => invoke<Bookmark[]>(IPC.bookmarks.list),
    add: (url: string, title: string) => invoke<Bookmark>(IPC.bookmarks.add, url, title),
    remove: (id: string) => invoke<void>(IPC.bookmarks.remove, id)
  },
  downloads: {
    list: () => invoke<DownloadTask[]>(IPC.downloads.list),
    analyze: (url: string, headers?: Record<string, string>, pageUrl?: string, pageTitle?: string) =>
      invoke<AnalyzeResult>(IPC.downloads.analyze, url, headers, pageUrl, pageTitle),
    analyzeDetected: (item: DetectedMedia) => invoke<AnalyzeResult>(IPC.downloads.analyzeDetected, item),
    quick: (item: DetectedMedia) => invoke<DownloadTask>(IPC.downloads.quick, item),
    getLog: (id: string) => invoke<string[]>(IPC.downloads.getLog, id),
    enqueue: (req: EnqueueRequest) => invoke<DownloadTask>(IPC.downloads.enqueue, req),
    pause: (id: string) => invoke<void>(IPC.downloads.pause, id),
    resume: (id: string) => invoke<void>(IPC.downloads.resume, id),
    cancel: (id: string) => invoke<void>(IPC.downloads.cancel, id),
    retry: (id: string) => invoke<void>(IPC.downloads.retry, id),
    remove: (id: string, deleteFile?: boolean) => invoke<void>(IPC.downloads.remove, id, deleteFile),
    clearFinished: () => invoke<void>(IPC.downloads.clearFinished),
    openFile: (id: string) => invoke<string>(IPC.downloads.openFile, id),
    showInFolder: (id: string) => invoke<void>(IPC.downloads.showInFolder, id),
    onUpdate: (cb: (t: DownloadTask) => void) => on<DownloadTask>(IPC.downloads.evUpdate, cb),
    onRemoved: (cb: (id: string) => void) => on<string>(IPC.downloads.evRemoved, cb)
  },
  library: {
    list: () => invoke<DownloadRecord[]>(IPC.library.list),
    check: (q: DuplicateQuery) => invoke<DuplicateMatch[]>(IPC.library.check, q),
    remove: (id: string) => invoke<void>(IPC.library.remove, id),
    clear: () => invoke<void>(IPC.library.clear),
    onChanged: (cb: () => void) => on<void>(IPC.library.evChanged, cb)
  },
  batch: {
    list: () => invoke<BatchJob[]>(IPC.batch.list),
    preview: (url: string, tabId?: number, filter?: string) => invoke<BatchPreview>(IPC.batch.preview, url, tabId, filter),
    create: (url: string, options?: Partial<BatchOptions>) => invoke<BatchJob>(IPC.batch.create, url, options),
    resume: (id: string) => invoke<void>(IPC.batch.resume, id),
    pause: (id: string) => invoke<void>(IPC.batch.pause, id),
    stop: (id: string) => invoke<void>(IPC.batch.stop, id),
    remove: (id: string, cancelTasks?: boolean) => invoke<void>(IPC.batch.remove, id, cancelTasks),
    retryFailed: (id: string) => invoke<void>(IPC.batch.retryFailed, id),
    retryItem: (id: string, itemId: string) => invoke<void>(IPC.batch.retryItem, id, itemId),
    resumeItem: (id: string, itemId: string) => invoke<void>(IPC.batch.resumeItem, id, itemId),
    skipItem: (id: string, itemId: string) => invoke<void>(IPC.batch.skipItem, id, itemId),
    onUpdate: (cb: (j: BatchJob) => void) => on<BatchJob>(IPC.batch.evUpdate, cb),
    onRemoved: (cb: (id: string) => void) => on<string>(IPC.batch.evRemoved, cb)
  },
  files: {
    list: () => invoke<FileEntry[]>(IPC.files.list),
    open: (p: string) => invoke<string>(IPC.files.open, p),
    showInFolder: (p: string) => invoke<void>(IPC.files.showInFolder, p),
    remove: (p: string) => invoke<void>(IPC.files.remove, p),
    rename: (p: string, newName: string) => invoke<string>(IPC.files.rename, p, newName),
    mediaUrl: (p: string) => invoke<string>(IPC.files.mediaUrl, p),
    pickFiles: () => invoke<string[]>(IPC.files.pickFiles)
  },
  player: {
    proxyUrl: (url: string, headers?: Record<string, string>) => invoke<string>(IPC.player.proxyUrl, url, headers)
  },
  adblock: {
    status: () => invoke<AdblockStatus>(IPC.adblock.status),
    setEnabled: (enabled: boolean) => invoke<void>(IPC.adblock.setEnabled, enabled),
    setDoh: (doh: boolean) => invoke<void>(IPC.adblock.setDoh, doh),
    setLists: (ids: string[]) => invoke<void>(IPC.adblock.setLists, ids),
    setCustomRules: (text: string) => invoke<void>(IPC.adblock.setCustomRules, text),
    setAllowed: (host: string, allowed: boolean) => invoke<void>(IPC.adblock.setAllowed, host, allowed),
    update: () => invoke<void>(IPC.adblock.update),
    tabStats: (tabId: number) => invoke<AdblockTabStats>(IPC.adblock.tabStats, tabId),
    onStatus: (cb: (s: AdblockStatus) => void) => on<AdblockStatus>(IPC.adblock.evStatus, cb)
  },
  thumbnails: {
    local: (p: string) => invoke<ThumbnailResult>(IPC.thumbnails.local, p),
    remote: (url: string, headers?: Record<string, string>) => invoke<string | null>(IPC.thumbnails.remote, url, headers),
    store: (p: string, dataUrl: string) => invoke<string>(IPC.thumbnails.store, p, dataUrl),
    cacheInfo: () => invoke<ThumbnailCacheInfo>(IPC.thumbnails.cacheInfo),
    clear: () => invoke<void>(IPC.thumbnails.clear)
  },
  vault: {
    state: () => invoke<VaultState>(IPC.vault.state),
    setup: (pin: string) => invoke<VaultState>(IPC.vault.setup, pin),
    unlock: (pin: string) => invoke<VaultState>(IPC.vault.unlock, pin),
    lock: () => invoke<VaultState>(IPC.vault.lock),
    add: (paths: string[]) => invoke<VaultState>(IPC.vault.add, paths),
    remove: (id: string) => invoke<VaultState>(IPC.vault.remove, id),
    open: (id: string) => invoke<string>(IPC.vault.open, id),
    export: (id: string) => invoke<string | null>(IPC.vault.export, id),
    changePin: (oldPin: string, newPin: string) => invoke<void>(IPC.vault.changePin, oldPin, newPin),
    thumb: (id: string) => invoke<string | null>(IPC.vault.thumb, id)
  },
  settings: {
    get: () => invoke<Settings>(IPC.settings.get),
    set: (patch: Partial<Settings>) => invoke<Settings>(IPC.settings.set, patch),
    chooseDir: (current?: string) => invoke<string | null>(IPC.settings.chooseDir, current)
  },
  tools: {
    status: (fresh?: boolean) => invoke<ToolStatus[]>(IPC.tools.status, fresh),
    install: (name: ToolName) => invoke<ToolStatus>(IPC.tools.install, name),
    onProgress: (cb: (p: ToolInstallProgress) => void) => on<ToolInstallProgress>(IPC.tools.evProgress, cb)
  },
  app: {
    version: () => invoke<string>(IPC.app.version),
    openExternal: (url: string) => invoke<void>(IPC.app.openExternal, url),
    checkUpdate: () => invoke<UpdateInfo>(IPC.app.checkUpdate),
    installUpdate: () => invoke<void>(IPC.app.installUpdate),
    updateStatus: () => invoke<UpdateInfo>(IPC.app.updateStatus),
    onNotify: (cb: (n: AppNotification) => void) => on<AppNotification>(IPC.app.evNotify, cb),
    onUpdate: (cb: (u: UpdateInfo) => void) => on<UpdateInfo>(IPC.app.evUpdate, cb),
    onNavigate: (cb: (ev: NavigateEvent) => void) => on<NavigateEvent>(IPC.app.evNavigate, cb)
  }
}

export type Api = typeof api

contextBridge.exposeInMainWorld('api', api)
