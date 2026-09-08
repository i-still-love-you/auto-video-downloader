import { app, net, type BrowserWindow } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { TabManager } from './browser/tabs'
import type { Sniffer } from './browser/sniffer'
import { mediaUrlFor, proxyUrlFor } from './protocols'
import { getSettings } from './settings'

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
export function runSmoke(win: BrowserWindow, tabs: TabManager, sniffer: Sniffer): void {
  if (!process.env.VDL_SMOKE) return
  const url = process.env.VDL_SMOKE_URL
  const outDir = process.env.VDL_SMOKE_OUT ?? app.getPath('temp')
  const wait = Number(process.env.VDL_SMOKE_WAIT ?? 12000)
  const consoleLines: string[] = []
  win.webContents.on('console-message', (event) => {
    consoleLines.push(`[${event.level}] ${event.message} (${event.sourceId}:${event.lineNumber})`)
  })
  if (url) setTimeout(() => tabs.newTab(url, true), 1500)
  setTimeout(async () => {
    const report: Record<string, unknown> = {
      tabs: tabs.getState(),
      detected: sniffer.getDetected(),
      console: consoleLines,
      protocols: await checkProtocols(sniffer)
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
