import { app, BrowserWindow, Menu, session, shell, webContents, type Session } from 'electron'
import path from 'node:path'
import { installProtocols, registerSchemes } from './protocols'
import { flushSettings, getSettings, initSettings } from './settings'
import { flushDb, initDb } from './storage/db'
import { Sniffer } from './browser/sniffer'
import { TabManager } from './browser/tabs'
import { AdBlocker } from './browser/adblock'
import { DownloadManager } from './downloads/manager'
import { BatchManager } from './batch/manager'
import { cookieHeaderFor } from './downloads/net'
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
let batch: BatchManager | null = null
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
    backgroundColor: '#0a0a0a',
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
    // 크롤러 숨김 창이 남아 있으면 window-all-closed 가 오지 않으므로 먼저 정리한다
    batch?.pauseAll()
    tabs?.destroy()
    tabs = null
    win = null
  })

  if (app.isPackaged) {
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [CSP] } })
    })
  }

  // 이전 버전이 디스크에 남긴 브라우저 데이터(persist:browser)는 더 이상 쓰지 않으므로 지운다.
  // 이제 탭 세션은 모두 메모리 전용이라 앱을 닫으면 쿠키·저장소·캐시가 남지 않는다.
  const legacy = session.fromPartition('persist:browser')
  void legacy.clearStorageData().catch(() => undefined)
  void legacy.clearCache().catch(() => undefined)

  const sniffer = new Sniffer((id) => tabs?.hasTab(id) ?? false)
  if (!adblock) {
    adblock = new AdBlocker()
    void adblock.init()
  }
  const blocker = adblock
  const filter = { urls: ['http://*/*', 'https://*/*'] }
  const userAgent = browserUserAgent()

  /** 탭 세션이 새로 만들어질 때마다 UA, 권한, preload, 감지기·차단기 리스너, 다운로드 가로채기를 붙인다. */
  const prepareSession = (s: Session): void => {
    s.setUserAgent(userAgent)
    s.setPermissionRequestHandler((_wc, permission, callback) => {
      callback(['fullscreen', 'pointerLock', 'clipboard-sanitized-write'].includes(permission))
    })
    try {
      s.registerPreloadScript({ type: 'frame', filePath: path.join(__dirname, '../preload/scan.js') })
    } catch (e) {
      console.error('scan preload 등록 실패', e)
    }
    blocker.attachSession(s)
    // 세션당 webRequest 리스너는 이벤트마다 하나뿐이므로 광고 차단기와 감지기를 한 리스너에서 합쳐 호출한다
    s.webRequest.onBeforeRequest(filter, (details, callback) => blocker.onBeforeRequest(details, callback))
    s.webRequest.onBeforeSendHeaders(filter, (details, callback) => {
      sniffer.handleBeforeSendHeaders(details)
      callback({ requestHeaders: details.requestHeaders })
    })
    s.webRequest.onHeadersReceived(filter, (details, callback) => {
      sniffer.handleHeadersReceived(details)
      blocker.onHeadersReceived(details, callback)
    })
    s.on('will-download', (event, item, wc) => {
      if (!getSettings().interceptBrowserDownloads || !downloads) return
      event.preventDefault()
      const url = item.getURL()
      const filename = item.getFilename()
      const mime = item.getMimeType()
      const size = item.getTotalBytes() || null
      const pageUrl = wc?.getURL()
      void cookieHeaderFor(s, url).then((cookie) => {
        const task = downloads!.enqueueDirect({
          url,
          filename,
          mime,
          size,
          pageUrl,
          headers: { Referer: pageUrl ?? '', 'User-Agent': userAgent, ...(cookie ? { Cookie: cookie } : {}) }
        })
        win?.webContents.send(IPC.app.evNotify, { type: 'info', message: `다운로드를 추가했습니다: ${task.title}` })
      })
    })
  }

  tabs = new TabManager(win, sniffer, adblock, prepareSession)
  await tabs.restoreSession()
  downloads!.setSessionResolver((tabId) => {
    const wc = tabId !== undefined ? webContents.fromId(tabId) : tabs?.activeWebContents()
    return wc && !wc.isDestroyed() ? wc.session : null
  }, userAgent)

  if (!batch) {
    const firstTabs = tabs
    batch = new BatchManager({
      downloads: downloads!,
      // 탭 세션(쿠키·로그인)을 빌리고, 없으면 크롤러 전용 메모리 세션을 쓴다
      sessionFor: (tabId) => {
        const tm = tabs ?? firstTabs
        return (tabId !== undefined ? tm.sessionOfTab(tabId) : undefined) ?? tm.serviceSession('batch-crawler')
      },
      userAgent
    })
    await batch.init()
  }

  registerIpc({ win, tabs, sniffer, downloads: downloads!, batch, vault: vault!, adblock })
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
      await batch?.shutdown()
      await downloads?.shutdown()
      await vault?.lock()
      await flushSettings()
      await flushDb()
    } finally {
      app.exit(0)
    }
  })()
})
