import { app, BrowserWindow, Menu, dialog, session, shell, webContents, type Session } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import { installProtocols, registerSchemes } from './protocols'
import { flushSettings, getSettings, initSettings } from './settings'
import { flushDb, initDb } from './storage/db'
import { Sniffer } from './browser/sniffer'
import { TabManager } from './browser/tabs'
import { AdBlocker } from './browser/adblock'
import { DownloadManager } from './downloads/manager'
import { Library } from './downloads/library'
import { BatchManager } from './batch/manager'
import { cookieHeaderFor } from './downloads/net'
import { Vault } from './vault/vault'
import { registerIpc } from './ipc'
import { setupUpdater } from './updater'
import { runSmoke } from './smoke'
import { initThumbnails } from './thumbnails'
import { ensureDir, errorMessage } from './util'
import { IPC } from '@shared/ipc'

registerSchemes()
// 메인 프로세스에서 잡히지 않은 예외가 나면 Electron 은 기본적으로 모달 오류 창을 띄우고, 창을 닫을 때까지 다운로드를 포함한
// 모든 처리가 멈춘다. 네트워크 라이브러리(undici) 내부 단언처럼 호출한 쪽에서 잡을 수 없는 비동기 오류가 간헐적으로 나므로
// 기록하고 알린 뒤 계속 진행한다. (리스너를 등록하면 Electron 의 기본 오류 창은 뜨지 않는다)
process.on('uncaughtException', (err) => {
  console.error('메인 프로세스 예외 (계속 진행):', err)
  if (win && !win.isDestroyed()) win.webContents.send(IPC.app.evNotify, { type: 'error', message: `내부 오류가 났지만 계속 진행합니다: ${errorMessage(err)}` })
})
/**
 * 앱 이름이 "video-downloader" 에서 "auto-video-downloader" 로 바뀌면서 기본 사용자 데이터 폴더(%APPDATA%\<앱 이름>)도 함께 바뀌었다.
 * 이전 이름으로 쓰던 설정·다운로드 이력·세션·개인 폴더가 사라진 것처럼 보이지 않도록, 새 폴더에는 아직 데이터가 없고 이전 폴더에
 * 있으면 이전 폴더를 그대로 쓴다. (setPath 는 requestSingleInstanceLock 과 ready 이전에 불러야 한다)
 */
function useLegacyUserDataIfPresent(): void {
  const markers = ['settings.json', 'library.json', 'downloads.json', 'session.json', 'history.json']
  const hasData = (dir: string): boolean => markers.some((f) => fs.existsSync(path.join(dir, f)))
  const current = app.getPath('userData')
  const legacy = path.join(app.getPath('appData'), 'video-downloader')
  if (legacy === current || hasData(current) || !hasData(legacy)) return
  app.setPath('userData', legacy)
}
// 포터블 모드/테스트용 사용자 데이터 폴더 지정
if (process.env.VDL_USER_DATA) app.setPath('userData', path.resolve(process.env.VDL_USER_DATA))
else useLegacyUserDataIfPresent()

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
let library: Library | null = null
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

/**
 * 브라우저 탭·UI 렌더러·다운로드가 모두 함께 쓰는 User-Agent. 기본 UA 에서 앱 이름 토큰("auto-video-downloader/<버전>")만 빼고
 * "Electron/xx" 토큰은 그대로 둔다.
 *
 * Cloudflare 보안 확인("Performing security verification")이 끝나지 않고 멈추는 원인이 두 가지 있었다.
 * 1) Electron 토큰까지 지워 순정 Chrome 처럼 보이게 하면 실패한다. UA 는 Chrome 이라고 하는데 Client Hints
 *    (navigator.userAgentData) 브랜드는 "Chromium" 뿐이라 위장으로 판정된다. Electron 토큰이 있으면 몇 초 만에 통과한다.
 * 2) 같은 앱 안에서 요청마다 UA 가 다르면 실패한다. 탭 세션만 setUserAgent 로 바꾸면 UI 렌더러(기본 세션)가 탭 목록의
 *    favicon 을 원래 UA(앱 이름 토큰 포함)로 같은 사이트에 요청하므로, 한 클라이언트가 두 UA 를 쓰는 것으로 보인다.
 *    그래서 세션별로 덮어쓰지 않고 app.userAgentFallback 자체를 바꿔 모든 세션이 같은 문자열을 쓰게 한다.
 * (Cloudflare 의 cf_clearance 쿠키는 UA 에 묶이므로 다운로드·yt-dlp·썸네일도 이 값을 그대로 써야 한다)
 */
function browserUserAgent(): string {
  const name = app.getName().replace(/\s+/g, '')
  return app.userAgentFallback.replace(new RegExp(` ${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\/\\S+`), '')
}
app.userAgentFallback = browserUserAgent()

async function createWindow(): Promise<void> {
  win = new BrowserWindow({
    width: 1320,
    height: 840,
    minWidth: 980,
    minHeight: 620,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#0a0a0a',
    title: 'Auto Video Downloader',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: !process.env.VDL_SMOKE
    }
  })
  win.once('ready-to-show', () => win?.show())
  // UI 렌더러가 죽으면 창에는 배경색만 남아 검게 보이고 아무 반응이 없다. 다운로드·크롤러는 메인 프로세스에서 돌고 있으므로
  // UI 만 다시 불러오면 상태가 그대로 복원된다.
  win.webContents.on('render-process-gone', (_e, details) => {
    if (quitting || details.reason === 'clean-exit') return
    console.error(`UI 렌더러가 종료되었습니다 (${details.reason}, exit ${details.exitCode}). 다시 불러옵니다.`)
    const w = win
    if (!w || w.isDestroyed()) return
    w.webContents.once('did-finish-load', () => {
      w.webContents.send(IPC.app.evNotify, { type: 'info', message: `화면이 예기치 않게 종료되어 다시 불러왔습니다 (${details.reason})` })
    })
    setTimeout(() => {
      if (!w.isDestroyed()) w.webContents.reload()
    }, 300)
  })
  win.webContents.on('unresponsive', () => {
    const w = win
    if (!w || w.isDestroyed() || quitting) return
    void dialog
      .showMessageBox(w, {
        type: 'warning',
        title: 'Auto Video Downloader',
        message: '화면이 응답하지 않습니다',
        detail: '다운로드는 계속 진행됩니다. 화면만 다시 불러올 수 있습니다.',
        buttons: ['다시 불러오기', '기다리기'],
        defaultId: 1,
        cancelId: 1
      })
      .then(({ response }) => {
        // 강제 종료하면 위의 render-process-gone 처리에서 다시 불러온다
        if (response === 0 && !w.isDestroyed()) w.webContents.forcefullyCrashRenderer()
      })
  })
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
      library: library!,
      // 탭 세션(쿠키·로그인)을 빌리고, 없으면 크롤러 전용 메모리 세션을 쓴다
      sessionFor: (tabId) => {
        const tm = tabs ?? firstTabs
        return (tabId !== undefined ? tm.sessionOfTab(tabId) : undefined) ?? tm.serviceSession('batch-crawler')
      },
      userAgent
    })
    await batch.init()
  }

  registerIpc({ win, tabs, sniffer, downloads: downloads!, library: library!, batch, vault: vault!, adblock })
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
  // 다운로드 이력: 완료된 영상을 기록해 두고 중복을 판정한다. 이력이 없던 시절의 완료 목록은 한 번 옮겨 담는다.
  library = new Library()
  await library.init()
  library.importTasks(downloads.list())
  // 이력에 옮겨 담은 뒤에 오래된 완료 항목을 목록에서 정리한다
  downloads.pruneFinished()
  const lib = library
  downloads.setCompletionHook((task) => void lib.recordCompleted(task))
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
      await library?.flush()
      await vault?.lock()
      await flushSettings()
      await flushDb()
    } finally {
      app.exit(0)
    }
  })()
})
