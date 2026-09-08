import { app, BrowserWindow, Menu, session, shell } from 'electron'
import path from 'node:path'
import { installProtocols, registerSchemes } from './protocols'
import { flushSettings, getSettings, initSettings } from './settings'
import { flushDb, initDb } from './storage/db'
import { Sniffer } from './browser/sniffer'
import { TabManager } from './browser/tabs'
import { AdBlocker } from './browser/adblock'
import { DownloadManager } from './downloads/manager'
import { Vault } from './vault/vault'
import { registerIpc } from './ipc'
import { setupUpdater } from './updater'
import { runSmoke } from './smoke'
import { initThumbnails } from './thumbnails'
import { ensureDir } from './util'
import { IPC } from '@shared/ipc'

registerSchemes()
// 포터블 모드/테스트용 사용자 데이터 폴더 지정
if (process.env.VDL_USER_DATA) app.setPath('userData', path.resolve(process.env.VDL_USER_DATA))

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https: http:",
  "media-src 'self' media: mproxy: blob:",
  "connect-src 'self' media: mproxy:",
  "font-src 'self' data:"
].join('; ')

let win: BrowserWindow | null = null
let tabs: TabManager | null = null
let downloads: DownloadManager | null = null
let vault: Vault | null = null
let adblock: AdBlocker | null = null
let quitting = false

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })
}

function browserUserAgent(): string {
  return app.userAgentFallback
    .replace(/ Electron\/\S+/, '')
    .replace(new RegExp(` ${app.getName().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\/\\S+`), '')
}

async function createWindow(): Promise<void> {
  win = new BrowserWindow({
    width: 1320,
    height: 840,
    minWidth: 980,
    minHeight: 620,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#111318',
    title: 'Video Downloader',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: !process.env.VDL_SMOKE
    }
  })
  win.once('ready-to-show', () => win?.show())
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.on('closed', () => {
    tabs?.destroy()
    tabs = null
    win = null
  })

  if (app.isPackaged) {
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [CSP] } })
    })
  }

  const browserSession = session.fromPartition('persist:browser')
  browserSession.setUserAgent(browserUserAgent())
  browserSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(['fullscreen', 'pointerLock', 'clipboard-sanitized-write'].includes(permission))
  })
  // 재생 전 동영상 주소를 찾는 페이지 스캔 preload (모든 프레임)
  try {
    browserSession.registerPreloadScript({ type: 'frame', filePath: path.join(__dirname, '../preload/scan.js') })
  } catch (e) {
    console.error('scan preload 등록 실패', e)
  }

  // 세션당 webRequest 리스너는 이벤트마다 하나뿐이므로 광고 차단기와 감지기를 한 리스너에서 합쳐 호출한다
  const sniffer = new Sniffer(browserSession, (id) => tabs?.hasTab(id) ?? false)
  if (!adblock) {
    adblock = new AdBlocker(browserSession)
    void adblock.init()
  }
  const blocker = adblock
  const filter = { urls: ['http://*/*', 'https://*/*'] }
  browserSession.webRequest.onBeforeRequest(filter, (details, callback) => blocker.onBeforeRequest(details, callback))
  browserSession.webRequest.onBeforeSendHeaders(filter, (details, callback) => {
    sniffer.handleBeforeSendHeaders(details)
    callback({ requestHeaders: details.requestHeaders })
  })
  browserSession.webRequest.onHeadersReceived(filter, (details, callback) => {
    sniffer.handleHeadersReceived(details)
    blocker.onHeadersReceived(details, callback)
  })

  tabs = new TabManager(win, browserSession, sniffer, adblock)
  await tabs.restoreSession()
  downloads!.setBrowserSession(browserSession)

  browserSession.on('will-download', (event, item, wc) => {
    if (!getSettings().interceptBrowserDownloads || !downloads) return
    event.preventDefault()
    const url = item.getURL()
    const task = downloads.enqueueDirect({
      url,
      filename: item.getFilename(),
      mime: item.getMimeType(),
      size: item.getTotalBytes() || null,
      pageUrl: wc?.getURL(),
      headers: { Referer: wc?.getURL() ?? '', 'User-Agent': browserSession.getUserAgent() }
    })
    win?.webContents.send(IPC.app.evNotify, { type: 'info', message: `다운로드를 추가했습니다: ${task.title}` })
  })

  registerIpc({ win, tabs, sniffer, downloads: downloads!, vault: vault!, browserSession, adblock })
  setupUpdater(win, getSettings().autoUpdate)

  if (process.env.ELECTRON_RENDERER_URL) await win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else await win.loadFile(path.join(__dirname, '../renderer/index.html'))
  runSmoke(win, tabs, sniffer, adblock)
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null)
  await initSettings()
  await initDb()
  await ensureDir(getSettings().downloadDir).catch(() => undefined)
  installProtocols()
  initThumbnails()
  downloads = new DownloadManager()
  await downloads.init()
  vault = new Vault(() => getSettings().vaultDir)
  await createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', (event) => {
  if (quitting) return
  quitting = true
  event.preventDefault()
  void (async () => {
    try {
      tabs?.saveSessionSync()
      adblock?.destroy()
      await downloads?.shutdown()
      await vault?.lock()
      await flushSettings()
      await flushDb()
    } finally {
      app.exit(0)
    }
  })()
})
