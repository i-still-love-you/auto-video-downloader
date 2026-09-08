import { app, type BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'
import { IPC } from '@shared/ipc'
import type { UpdateInfo } from '@shared/types'

let current: UpdateInfo = { status: 'idle' }
let win: BrowserWindow | null = null
let ready = false

function set(info: UpdateInfo): void {
  current = info
  if (win && !win.isDestroyed()) win.webContents.send(IPC.app.evUpdate, info)
}

export function setupUpdater(window: BrowserWindow, autoCheck: boolean): void {
  win = window
  if (!app.isPackaged) {
    current = { status: 'unsupported', message: '개발 모드에서는 자동 업데이트를 사용할 수 없습니다' }
    return
  }
  try {
    autoUpdater.autoDownload = true
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.on('checking-for-update', () => set({ status: 'checking' }))
    autoUpdater.on('update-available', (info) => set({ status: 'available', version: info.version }))
    autoUpdater.on('update-not-available', (info) => set({ status: 'not-available', version: info.version }))
    autoUpdater.on('update-downloaded', (info) => set({ status: 'downloaded', version: info.version }))
    autoUpdater.on('error', (err) => set({ status: 'error', message: err?.message ?? String(err) }))
    ready = true
    if (autoCheck) setTimeout(() => void checkUpdate(), 8000)
  } catch (e) {
    current = { status: 'error', message: e instanceof Error ? e.message : String(e) }
  }
}

export async function checkUpdate(): Promise<UpdateInfo> {
  if (!ready) return current
  try {
    await autoUpdater.checkForUpdates()
  } catch (e) {
    set({ status: 'error', message: e instanceof Error ? e.message : String(e) })
  }
  return current
}

export function installUpdate(): void {
  if (ready && current.status === 'downloaded') autoUpdater.quitAndInstall()
}

export function updateStatus(): UpdateInfo {
  return current
}
