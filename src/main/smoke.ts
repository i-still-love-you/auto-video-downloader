import { app, net, type BrowserWindow } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { TabManager } from './browser/tabs'
import type { Sniffer } from './browser/sniffer'
import type { AdBlocker } from './browser/adblock'
import { mediaUrlFor, proxyUrlFor } from './protocols'
import { getSettings } from './settings'
import { localThumbnail, remoteThumbnail } from './thumbnails'
import { IPC } from '@shared/ipc'

/** 탭 세션 격리 점검: 각 탭의 세션이 메모리 전용인지, 서로 다른지, 쿠키가 새는지 확인한다. */
async function checkSessions(tabs: TabManager): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {}
  const { webContents } = await import('electron')
  const withUrl = tabs.getState().tabs.filter((t) => /^https?:/.test(t.url))
  const wcs = withUrl.map((t) => webContents.fromId(t.id)).filter((w): w is Electron.WebContents => !!w && !w.isDestroyed())
  out.tabs = wcs.map((w, i) => ({ id: w.id, url: w.getURL(), persistent: w.session.isPersistent(), sameSessionAsFirst: i === 0 ? null : w.session === wcs[0].session }))
  if (wcs.length >= 2) {
    const url = wcs[0].getURL()
    try {
      await wcs[0].session.cookies.set({ url, name: 'vdl_probe', value: '1' })
      const inFirst = (await wcs[0].session.cookies.get({ url })).some((c) => c.name === 'vdl_probe')
      const inSecond = (await wcs[1].session.cookies.get({ url })).some((c) => c.name === 'vdl_probe')
      out.cookieProbe = { setInFirst: inFirst, leakedToSecond: inSecond }
    } catch (e) {
      out.cookieProbeError = String(e)
    }
    // 복제 탭은 원래 탭 세션을 물려받아야 한다
    const dupId = tabs.duplicateTab(wcs[0].id)
    const dup = dupId !== null ? webContents.fromId(dupId) : null
    out.duplicateSharesSession = dup ? dup.session === wcs[0].session : null
    if (dupId !== null) tabs.closeTab(dupId)
  }
  return out
}

async function checkThumbnails(sniffer: Sniffer): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {}
  try {
    const dir = getSettings().downloadDir
    const file = (await fs.readdir(dir)).find((f) => /\.mp4$/i.test(f))
    if (file) {
      const t0 = Date.now()
      out.local = { ...(await localThumbnail(path.join(dir, file))), ms: Date.now() - t0 }
    }
  } catch (e) {
    out.localError = String(e)
  }
  const hls = sniffer.getDetected().find((d) => d.kind === 'hls')
  if (hls) {
    const t0 = Date.now()
    try {
      out.remoteHls = { url: await remoteThumbnail(hls.url, hls.headers), ms: Date.now() - t0 }
    } catch (e) {
      out.remoteHlsError = String(e)
    }
  }
  const file = sniffer.getDetected().find((d) => d.kind === 'file')
  if (file) {
    const t0 = Date.now()
    try {
      out.remoteFile = { url: await remoteThumbnail(file.url, file.headers), ms: Date.now() - t0 }
    } catch (e) {
      out.remoteFileError = String(e)
    }
  }
  return out
}

async function checkProtocols(sniffer: Sniffer): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {}
  const hls = sniffer.getDetected().find((d) => d.kind === 'hls')
  if (hls) {
    try {
      const res = await net.fetch(proxyUrlFor(hls.url, hls.headers))
      const text = await res.text()
      out.proxy = { status: res.status, contentType: res.headers.get('content-type'), head: text.slice(0, 400) }
    } catch (e) {
      out.proxyError = String(e)
    }
  }
  try {
    const dir = getSettings().downloadDir
    const file = (await fs.readdir(dir)).find((f) => /\.mp4$/i.test(f))
    if (file) {
      const res = await net.fetch(mediaUrlFor(path.join(dir, file)), { headers: { Range: 'bytes=0-99' } })
      const buf = Buffer.from(await res.arrayBuffer())
      out.media = { status: res.status, contentRange: res.headers.get('content-range'), length: buf.length, type: res.headers.get('content-type') }
      const denied = await net.fetch(mediaUrlFor(path.join(app.getPath('home'), 'nope.mp4')))
      out.mediaDeniedStatus = denied.status
    }
  } catch (e) {
    out.mediaError = String(e)
  }
  return out
}

/**
 * 자동 점검 모드 (환경 변수 VDL_SMOKE=1).
 * VDL_SMOKE_URL 페이지를 새 탭으로 열고 일정 시간 뒤 감지 결과/콘솔 로그/스크린샷을
 * VDL_SMOKE_OUT 폴더에 저장한 다음 종료한다. CI 나 개발 중 빠른 확인용.
 */
export function runSmoke(win: BrowserWindow, tabs: TabManager, sniffer: Sniffer, adblock?: AdBlocker): void {
  if (!process.env.VDL_SMOKE) return
  const url = process.env.VDL_SMOKE_URL
  const outDir = process.env.VDL_SMOKE_OUT ?? app.getPath('temp')
  const wait = Number(process.env.VDL_SMOKE_WAIT ?? 12000)
  const consoleLines: string[] = []
  win.webContents.on('console-message', (event) => {
    consoleLines.push(`[${event.level}] ${event.message} (${event.sourceId}:${event.lineNumber})`)
  })
  let smokeTabId: number | null = null
  if (url) setTimeout(() => (smokeTabId = tabs.newTab(url, true)), 1500)
  // VDL_SMOKE_URL2: 3초 뒤 두 번째 탭, VDL_SMOKE_JS: 6초 뒤 렌더러에서 실행할 JS (window.api 사용 가능)
  const url2 = process.env.VDL_SMOKE_URL2
  if (url2) setTimeout(() => tabs.newTab(url2, true), 3000)
  // VDL_SMOKE_TABCLICKS: "x,y@ms;x,y@ms" 형식으로 지정한 시각에 점검 탭에 실제 마우스 클릭을 보낸다
  const clicks = process.env.VDL_SMOKE_TABCLICKS
  if (clicks) {
    for (const spec of clicks.split(';')) {
      const m = /^(\d+),(\d+)@(\d+)$/.exec(spec.trim())
      if (!m) continue
      const [x, y, at] = [Number(m[1]), Number(m[2]), Number(m[3])]
      setTimeout(() => {
        if (smokeTabId === null || !tabs.hasTab(smokeTabId)) return
        tabs.activate(smokeTabId)
        const wc = tabs.activeWebContents()
        if (!wc) return
        wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
        wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
        consoleLines.push(`[smoke] tab click ${x},${y} @${at}`)
      }, at)
    }
  }
  const js = process.env.VDL_SMOKE_JS
  if (js) {
    setTimeout(() => {
      void win.webContents
        .executeJavaScript(js)
        .then((r) => consoleLines.push(`[smoke] js: ${JSON.stringify(r) ?? 'undefined'}`))
        .catch((e) => consoleLines.push(`[smoke] js failed: ${e}`))
    }, 6000)
  }
  const page = process.env.VDL_SMOKE_PAGE
  if (page) {
    if (process.env.VDL_SMOKE_HOOK) {
      setTimeout(() => {
        void win.webContents
          .executeJavaScript('window.__navLog = []; window.api.app.onNavigate((ev) => window.__navLog.push(JSON.stringify(ev))); "ok"')
          .catch((e) => consoleLines.push(`[smoke] hook failed: ${e}`))
      }, 1000)
    }
    for (const delay of [2500, 5000]) setTimeout(() => win.webContents.send(IPC.app.evNavigate, { page }), delay)
  }
  // VDL_SMOKE_CLICK: 일정 시간 뒤 클릭할 CSS 선택자 (예: 격자 보기 토글, 감지 패널 버튼)
  const click = process.env.VDL_SMOKE_CLICK
  if (click) {
    setTimeout(() => {
      void win.webContents
        .executeJavaScript(`(() => { const el = document.querySelector(${JSON.stringify(click)}); if (el) { el.click(); return 'clicked' } return 'missing' })()`)
        .then((r) => consoleLines.push(`[smoke] click ${click}: ${r}`))
        .catch((e) => consoleLines.push(`[smoke] click failed: ${e}`))
    }, 6000)
  }
  setTimeout(async () => {
    // 가려진 창은 다시 그려지지 않으므로 캡처 전에 앞으로 가져와 강제로 다시 그린다
    try {
      if (smokeTabId !== null && tabs.hasTab(smokeTabId)) tabs.activate(smokeTabId)
      win.show()
      win.moveTop()
      win.focus()
      win.webContents.invalidate()
      await new Promise((r) => setTimeout(r, 800))
    } catch {
      /* ignore */
    }
    let activePage: unknown = null
    let navLog: unknown = null
    try {
      activePage = await win.webContents.executeJavaScript('document.querySelector(".nav-item.active")?.textContent ?? null')
      navLog = await win.webContents.executeJavaScript('JSON.stringify(window.__navLog ?? null)')
    } catch (e) {
      activePage = String(e)
    }
    const report: Record<string, unknown> = {
      activePage,
      navLog,
      tabs: tabs.getState(),
      detected: sniffer.getDetected(),
      console: consoleLines,
      popups: smokeTabId !== null ? tabs.popupStats(smokeTabId) : null,
      sessions: await checkSessions(tabs),
      protocols: await checkProtocols(sniffer),
      thumbnails: await checkThumbnails(sniffer),
      adblock: adblock
        ? {
            ...(await adblock.status()),
            cacheLoadMs: adblock.cacheLoadMs,
            smokeTabId,
            tabs: tabs.getState().tabs.map((t) => ({ id: t.id, url: t.url, blocked: t.blockedCount })),
            synthetic: {
              doubleclickScript: adblock.test('https://securepubads.g.doubleclick.net/tag/js/gpt.js', 'script'),
              googleAnalytics: adblock.test('https://www.google-analytics.com/analytics.js', 'script'),
              plainImage: adblock.test('https://example.com/logo.png', 'image')
            }
          }
        : null
    }
    await fs.mkdir(outDir, { recursive: true })
    try {
      const img = await win.webContents.capturePage()
      await fs.writeFile(path.join(outDir, 'smoke-ui.png'), img.toPNG())
    } catch (e) {
      report.uiScreenshotError = String(e)
    }
    try {
      const wc = tabs.activeWebContents()
      if (wc) {
        const img = await wc.capturePage()
        await fs.writeFile(path.join(outDir, 'smoke-tab.png'), img.toPNG())
      }
    } catch (e) {
      report.tabScreenshotError = String(e)
    }
    await fs.writeFile(path.join(outDir, 'smoke.json'), JSON.stringify(report, null, 2))
    app.quit()
  }, wait)
}
