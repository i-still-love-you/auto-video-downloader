import { app, dialog, ipcMain, shell, type BrowserWindow } from 'electron'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import { IPC } from '@shared/ipc'
import {
  MEDIA_EXTENSIONS,
  type AppNotification,
  type BatchOptions,
  type DetectedMedia,
  type EnqueueRequest,
  type FileEntry,
  type NavigateEvent,
  type Rect,
  type ScanPayload,
  type Settings,
  type ToolName
} from '@shared/types'
import type { TabManager } from './browser/tabs'
import type { Sniffer } from './browser/sniffer'
import type { DownloadManager } from './downloads/manager'
import type { BatchManager } from './batch/manager'
import type { Vault } from './vault/vault'
import type { AdBlocker } from './browser/adblock'
import { getSettings, updateSettings } from './settings'
import * as db from './storage/db'
import { installTool, invalidateToolCache, toolsStatus } from './tools/binaries'
import { mediaUrlFor, proxyUrlFor } from './protocols'
import { checkUpdate, installUpdate, updateStatus } from './updater'
import { cacheInfo, clearCache, localThumbnail, remoteThumbnail, storeThumbnail } from './thumbnails'
import { ensureDir, isMediaExt, sanitizeFilename } from './util'

export interface IpcDeps {
  win: BrowserWindow
  tabs: TabManager
  sniffer: Sniffer
  downloads: DownloadManager
  batch: BatchManager
  vault: Vault
  adblock: AdBlocker
}

export function registerIpc(d: IpcDeps): void {
  const send = (channel: string, payload?: unknown): void => {
    if (!d.win.isDestroyed()) d.win.webContents.send(channel, payload)
  }
  const notify = (n: AppNotification): void => send(IPC.app.evNotify, n)
  const navigate = (ev: NavigateEvent): void => send(IPC.app.evNavigate, ev)
  const handle = ipcMain.handle.bind(ipcMain)

  // ---------- 브라우저 ----------
  handle(IPC.browser.getState, () => d.tabs.getState())
  handle(IPC.browser.newTab, (_e, url?: string) => d.tabs.newTab(url || undefined))
  handle(IPC.browser.closeTab, (_e, id: number) => d.tabs.closeTab(id))
  handle(IPC.browser.closeOtherTabs, (_e, id: number) => d.tabs.closeOtherTabs(id))
  handle(IPC.browser.closeTabsToRight, (_e, id: number) => d.tabs.closeTabsToRight(id))
  handle(IPC.browser.duplicateTab, (_e, id: number) => d.tabs.duplicateTab(id))
  handle(IPC.browser.reopenClosedTab, () => d.tabs.reopenClosedTab())
  handle(IPC.browser.activateIndex, (_e, n: number) => d.tabs.activateIndex(n))
  handle(IPC.browser.tabMenu, (_e, id: number) => d.tabs.showTabMenu(id))
  handle(IPC.browser.popupStats, (_e, id: number) => d.tabs.popupStats(id))
  handle(IPC.browser.openBlockedPopup, (_e, id: number, url: string) => d.tabs.openBlockedPopup(id, url))
  handle(IPC.browser.setPopupAllowed, (_e, host: string, allowed: boolean) => d.tabs.setPopupAllowed(host, !!allowed))
  handle(IPC.browser.setPopupBlockEnabled, (_e, enabled: boolean) => d.tabs.setPopupBlockEnabled(!!enabled))
  d.tabs.on('popupBlocked', (info: { tabId: number; url: string; reason: string; host: string }) => {
    send(IPC.browser.evPopupBlocked, info)
    notify({ type: 'info', message: `팝업을 차단했습니다: ${info.host}`, action: { label: '열기', url: info.url, tabId: info.tabId } })
  })
  handle(IPC.browser.activateTab, (_e, id: number) => d.tabs.activate(id))
  handle(IPC.browser.navigate, (_e, id: number, input: string) => d.tabs.navigate(id, input))
  handle(IPC.browser.goBack, (_e, id: number) => d.tabs.goBack(id))
  handle(IPC.browser.goForward, (_e, id: number) => d.tabs.goForward(id))
  handle(IPC.browser.reload, (_e, id: number) => d.tabs.reload(id))
  handle(IPC.browser.stop, (_e, id: number) => d.tabs.stop(id))
  ipcMain.on(IPC.browser.setBounds, (_e, rect: Rect) => d.tabs.setBounds(rect))
  ipcMain.on(IPC.browser.setVisible, (_e, visible: boolean) => d.tabs.setVisible(visible))
  handle(IPC.browser.getDetected, (_e, tabId?: number) => d.sniffer.getDetected(tabId))
  handle(IPC.browser.clearDetected, (_e, tabId: number) => d.sniffer.clearTab(tabId))

  d.tabs.on('state', (s) => send(IPC.browser.evState, s))
  d.sniffer.on('detected', (item: DetectedMedia) => send(IPC.browser.evDetected, item))
  d.sniffer.on('updated', (item: DetectedMedia) => send(IPC.browser.evDetectedUpdated, item))

  // ---------- 페이지 스캔 (탭 preload 에서 옴) ----------
  handle(IPC.scan.config, () => getSettings().pageScan)
  ipcMain.on(IPC.scan.found, (event, payload: ScanPayload) => {
    if (!getSettings().pageScan.enabled) return
    const tabId = event.sender.id
    if (d.tabs.hasTab(tabId)) d.sniffer.addScanned(tabId, payload)
  })
  d.tabs.on('focusAddress', () => {
    d.win.webContents.focus()
    navigate({ page: 'browser', focusAddress: true })
  })
  d.tabs.on('bookmark', (id: number) => {
    const t = d.tabs.getState().tabs.find((x) => x.id === id)
    if (t?.url) {
      db.addBookmark(t.url, t.title)
      notify({ type: 'success', message: '즐겨찾기에 추가했습니다' })
    }
  })
  d.tabs.on('downloadUrl', (url: string, pageUrl: string) => {
    d.win.webContents.focus()
    navigate({ page: 'downloads', analyzeUrl: url, pageUrl })
  })
  d.tabs.on('batchUrl', (url: string) => {
    d.win.webContents.focus()
    navigate({ page: 'batch', batchUrl: url })
  })

  // ---------- 기록 / 즐겨찾기 ----------
  handle(IPC.history.list, (_e, query?: string, limit?: number) => db.listHistory(query, limit))
  handle(IPC.history.remove, (_e, id: string) => db.removeHistory(id))
  handle(IPC.history.clear, () => db.clearHistory())
  handle(IPC.bookmarks.list, () => db.listBookmarks())
  handle(IPC.bookmarks.add, (_e, url: string, title: string) => db.addBookmark(url, title))
  handle(IPC.bookmarks.remove, (_e, id: string) => db.removeBookmark(id))

  // ---------- 다운로드 ----------
  handle(IPC.downloads.list, () => d.downloads.list())
  handle(IPC.downloads.analyze, (_e, url: string, headers?: Record<string, string>, pageUrl?: string, pageTitle?: string) =>
    d.downloads.analyze(url, headers, pageUrl, pageTitle, d.tabs.activeTabId ?? undefined)
  )
  handle(IPC.downloads.analyzeDetected, (_e, item: DetectedMedia) => d.downloads.analyzeDetected(item))
  handle(IPC.downloads.quick, (_e, item: DetectedMedia) => d.downloads.quickDownload(item))
  handle(IPC.downloads.getLog, (_e, id: string) => d.downloads.getLog(id))
  handle(IPC.downloads.enqueue, (_e, req: EnqueueRequest) => d.downloads.enqueue(req))
  handle(IPC.downloads.pause, (_e, id: string) => d.downloads.pause(id))
  handle(IPC.downloads.resume, (_e, id: string) => d.downloads.resume(id))
  handle(IPC.downloads.cancel, (_e, id: string) => d.downloads.cancel(id))
  handle(IPC.downloads.retry, (_e, id: string) => d.downloads.retry(id))
  handle(IPC.downloads.remove, (_e, id: string, deleteFile?: boolean) => d.downloads.remove(id, !!deleteFile))
  handle(IPC.downloads.clearFinished, () => d.downloads.clearFinished())
  handle(IPC.downloads.openFile, (_e, id: string) => d.downloads.openFile(id))
  handle(IPC.downloads.showInFolder, (_e, id: string) => d.downloads.showInFolder(id))

  d.downloads.on('update', (t) => send(IPC.downloads.evUpdate, t))
  d.downloads.on('removed', (id) => send(IPC.downloads.evRemoved, id))
  d.downloads.on('notify', (n) => notify(n))

  // ---------- 자동(일괄) 다운로드 ----------
  handle(IPC.batch.list, () => d.batch.list())
  handle(IPC.batch.preview, (_e, url: string, tabId?: number, filter?: string) => d.batch.preview(String(url ?? ''), typeof tabId === 'number' ? tabId : undefined, typeof filter === 'string' ? filter : undefined))
  handle(IPC.batch.create, (_e, url: string, options?: Partial<BatchOptions>) => d.batch.create(String(url ?? ''), options))
  handle(IPC.batch.resume, (_e, id: string) => d.batch.resume(id))
  handle(IPC.batch.pause, (_e, id: string) => d.batch.pause(id))
  handle(IPC.batch.stop, (_e, id: string) => d.batch.stop(id))
  handle(IPC.batch.remove, (_e, id: string, cancelTasks?: boolean) => d.batch.remove(id, !!cancelTasks))
  handle(IPC.batch.retryFailed, (_e, id: string) => d.batch.retryFailed(id))
  handle(IPC.batch.retryItem, (_e, id: string, itemId: string) => d.batch.retryItem(id, itemId))
  handle(IPC.batch.resumeItem, (_e, id: string, itemId: string) => d.batch.resumeItem(id, itemId))
  handle(IPC.batch.skipItem, (_e, id: string, itemId: string) => d.batch.skipItem(id, itemId))
  d.batch.on('update', (j) => send(IPC.batch.evUpdate, j))
  d.batch.on('removed', (id) => send(IPC.batch.evRemoved, id))
  d.batch.on('notify', (n) => notify(n))

  // ---------- 파일 ----------
  handle(IPC.files.list, async (): Promise<FileEntry[]> => {
    const dir = getSettings().downloadDir
    await ensureDir(dir)
    const entries = await fs.readdir(dir, { withFileTypes: true })
    const out: FileEntry[] = []
    for (const e of entries) {
      if (!e.isFile()) continue
      if (/\.(part|ytdl|tmp|vdl\.json)$/i.test(e.name)) continue
      const p = path.join(dir, e.name)
      try {
        const st = await fs.stat(p)
        const ext = path.extname(e.name).slice(1).toLowerCase()
        out.push({ name: e.name, path: p, size: st.size, mtime: st.mtimeMs, ext, isMedia: isMediaExt(ext) })
      } catch {
        /* ignore */
      }
    }
    return out.sort((a, b) => b.mtime - a.mtime)
  })
  handle(IPC.files.open, (_e, p: string) => shell.openPath(p))
  handle(IPC.files.showInFolder, (_e, p: string) => shell.showItemInFolder(p))
  handle(IPC.files.remove, async (_e, p: string) => {
    try {
      await shell.trashItem(p)
    } catch {
      await fs.rm(p, { force: true })
    }
  })
  handle(IPC.files.rename, async (_e, p: string, newName: string) => {
    const clean = sanitizeFilename(newName)
    const ext = path.extname(p)
    const target = path.join(path.dirname(p), clean.toLowerCase().endsWith(ext.toLowerCase()) ? clean : clean + ext)
    if (target !== p) await fs.rename(p, target)
    return target
  })
  handle(IPC.files.mediaUrl, (_e, p: string) => mediaUrlFor(p))
  handle(IPC.files.pickFiles, async () => {
    const r = await dialog.showOpenDialog(d.win, {
      title: '개인 폴더에 추가할 파일 선택',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '미디어 파일', extensions: MEDIA_EXTENSIONS }, { name: '모든 파일', extensions: ['*'] }]
    })
    return r.canceled ? [] : r.filePaths
  })

  // ---------- 플레이어 ----------
  handle(IPC.player.proxyUrl, (_e, url: string, headers?: Record<string, string>) => proxyUrlFor(url, headers))

  // ---------- 광고 차단 ----------
  handle(IPC.adblock.status, () => d.adblock.status())
  handle(IPC.adblock.setEnabled, (_e, enabled: boolean) => d.adblock.setEnabled(!!enabled))
  handle(IPC.adblock.setDoh, (_e, doh: boolean) => d.adblock.setDoh(!!doh))
  handle(IPC.adblock.setLists, (_e, ids: string[]) => d.adblock.setLists(Array.isArray(ids) ? ids : []))
  handle(IPC.adblock.setCustomRules, (_e, text: string) => d.adblock.setCustomRules(String(text ?? '')))
  handle(IPC.adblock.setAllowed, (_e, host: string, allowed: boolean) => d.adblock.setAllowed(host, !!allowed))
  handle(IPC.adblock.update, () => d.adblock.update())
  handle(IPC.adblock.tabStats, (_e, tabId: number) => d.adblock.tabStats(tabId))
  d.adblock.on('status', (s) => send(IPC.adblock.evStatus, s))

  // ---------- 썸네일 ----------
  handle(IPC.thumbnails.local, (_e, p: string) => localThumbnail(p))
  handle(IPC.thumbnails.remote, (_e, url: string, headers?: Record<string, string>) => remoteThumbnail(url, headers))
  handle(IPC.thumbnails.store, (_e, p: string, dataUrl: string) => storeThumbnail(p, dataUrl))
  handle(IPC.thumbnails.cacheInfo, () => cacheInfo())
  handle(IPC.thumbnails.clear, () => clearCache())

  // ---------- 개인 폴더 ----------
  handle(IPC.vault.state, () => d.vault.state())
  handle(IPC.vault.setup, (_e, pin: string) => d.vault.setup(pin))
  handle(IPC.vault.unlock, (_e, pin: string) => d.vault.unlock(pin))
  handle(IPC.vault.lock, () => d.vault.lock())
  handle(IPC.vault.add, (_e, paths: string[]) => d.vault.add(paths))
  handle(IPC.vault.remove, (_e, id: string) => d.vault.remove(id))
  handle(IPC.vault.open, async (_e, id: string) => mediaUrlFor(await d.vault.open(id)))
  handle(IPC.vault.export, async (_e, id: string) => {
    const r = await dialog.showOpenDialog(d.win, { title: '내보낼 폴더 선택', properties: ['openDirectory', 'createDirectory'] })
    if (r.canceled || !r.filePaths[0]) return null
    return d.vault.export(id, r.filePaths[0])
  })
  handle(IPC.vault.changePin, (_e, oldPin: string, newPin: string) => d.vault.changePin(oldPin, newPin))
  handle(IPC.vault.thumb, (_e, id: string) => d.vault.thumb(id))

  // ---------- 설정 ----------
  handle(IPC.settings.get, () => getSettings())
  handle(IPC.settings.set, (_e, patch: Partial<Settings>) => {
    const s = updateSettings(patch)
    if (patch.toolPaths) invalidateToolCache()
    return s
  })
  handle(IPC.settings.chooseDir, async (_e, current?: string) => {
    const r = await dialog.showOpenDialog(d.win, {
      title: '폴더 선택',
      defaultPath: current,
      properties: ['openDirectory', 'createDirectory']
    })
    return r.canceled ? null : r.filePaths[0]
  })

  // ---------- 도구 ----------
  handle(IPC.tools.status, (_e, fresh?: boolean) => toolsStatus(!!fresh))
  handle(IPC.tools.install, (_e, name: ToolName) => installTool(name, (p) => send(IPC.tools.evProgress, p)))

  // ---------- 앱 ----------
  handle(IPC.app.version, () => app.getVersion())
  handle(IPC.app.openExternal, (_e, url: string) => {
    if (/^https?:\/\//i.test(url)) return shell.openExternal(url)
    return undefined
  })
  handle(IPC.app.checkUpdate, () => checkUpdate())
  handle(IPC.app.installUpdate, () => installUpdate())
  handle(IPC.app.updateStatus, () => updateStatus())
}
