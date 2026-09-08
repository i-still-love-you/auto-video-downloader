import { BrowserWindow, type Session, type WebContents } from 'electron'
import { extractListPage, type ListPageResult } from './pageScript'
import { abortError } from '../downloads/engines/types'

const LOAD_TIMEOUT = 45_000
const SETTLE_MS = 700

export interface LoadOptions {
  filter?: string
  referer?: string
  signal?: AbortSignal
}

export interface LoadedPage extends ListPageResult {
  httpStatus: number
}

/**
 * 목록 페이지를 숨김 창에 실제로 렌더링해서 링크를 뽑는다. 정적 HTML 만 읽는 것보다 느리지만
 * 스크립트로 채워지는 목록, 지연 로딩 썸네일, 보안 확인 페이지까지 다룰 수 있다.
 * 이미지는 내려받지 않고(images: false) 소리는 끈다. 작업당 하나만 만들고 끝나면 없앤다.
 */
export class PageLoader {
  private win: BrowserWindow | null = null
  private busy = false

  constructor(private readonly session: Session) {}

  private ensure(): BrowserWindow {
    if (this.win && !this.win.isDestroyed()) return this.win
    const win = new BrowserWindow({
      show: false,
      width: 1280,
      height: 900,
      webPreferences: {
        session: this.session,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        images: false,
        backgroundThrottling: false,
        autoplayPolicy: 'user-gesture-required',
        spellcheck: false
      }
    })
    win.webContents.setAudioMuted(true)
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    win.webContents.on('will-attach-webview', (e) => e.preventDefault())
    if (process.env.VDL_DEBUG_CRAWLER) {
      // 숨김 창 안의 콘솔을 터미널로 옮긴다 (페이지 스크립트 오류 추적용)
      win.webContents.on('console-message', (ev) => console.log(`[crawler:${ev.level}] ${ev.message} (${ev.sourceId}:${ev.lineNumber})`))
      win.webContents.on('preload-error', (_e, p, err) => console.log(`[crawler] preload error ${p}: ${err.message}`))
      win.webContents.on('did-navigate', (_e, url, code) => console.log(`[crawler] did-navigate ${code} ${url}`))
    }
    this.win = win
    return win
  }

  get active(): boolean {
    return this.busy
  }

  async load(url: string, opts: LoadOptions = {}): Promise<LoadedPage> {
    if (this.busy) throw new Error('이미 다른 페이지를 읽는 중입니다')
    if (opts.signal?.aborted) throw abortError()
    this.busy = true
    try {
      const wc = this.ensure().webContents
      const httpStatus = await this.navigate(wc, url, opts)
      await this.wait(SETTLE_MS, opts.signal)
      let result = await this.extract(wc, opts.filter)
      // 보안 확인 페이지는 자동으로 넘어가기도 하므로 잠시 기다렸다가 다시 본다. 빈 결과도 지연 렌더링일 수 있어 두 번 더 본다.
      for (let attempt = 0; attempt < 4; attempt++) {
        if (result.challenge) await this.wait(4000, opts.signal)
        else if (!result.total && attempt < 2) await this.wait(1500, opts.signal)
        else break
        result = await this.extract(wc, opts.filter)
      }
      // 스크립트가 목록을 계속 채우는 사이트(YouTube 등)는 개수가 더 늘지 않을 때까지 기다린다
      for (let round = 0; round < 4 && result.total > 0; round++) {
        await this.wait(1200, opts.signal)
        const again = await this.extract(wc, opts.filter)
        const grew = again.total > result.total
        if (again.total >= result.total) result = again
        if (!grew) break
      }
      return { ...result, httpStatus }
    } finally {
      this.busy = false
    }
  }

  private navigate(wc: WebContents, url: string, opts: LoadOptions): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      let status = 200
      let settled = false
      const cleanup = (): void => {
        clearTimeout(timer)
        opts.signal?.removeEventListener('abort', onAbort)
        if (!wc.isDestroyed()) wc.off('did-navigate', onNavigate)
      }
      const finish = (err?: Error): void => {
        if (settled) return
        settled = true
        cleanup()
        if (err) reject(err)
        else resolve(status)
      }
      const onNavigate = (_e: unknown, _url: string, code: number): void => {
        if (code) status = code
      }
      const onAbort = (): void => {
        if (!wc.isDestroyed()) wc.stop()
        finish(abortError())
      }
      const timer = setTimeout(() => {
        if (!wc.isDestroyed()) wc.stop()
        finish(new Error('페이지 로딩 시간이 초과되었습니다'))
      }, LOAD_TIMEOUT)
      opts.signal?.addEventListener('abort', onAbort, { once: true })
      wc.on('did-navigate', onNavigate)
      wc.loadURL(url, opts.referer ? { httpReferrer: opts.referer } : undefined).then(
        () => finish(),
        (e: Error & { errno?: number; code?: string }) => {
          // ERR_ABORTED(-3) 는 페이지 스크립트의 재이동 등으로 흔히 나며 실제 실패가 아니다
          if (e?.errno === -3 || e?.code === 'ERR_ABORTED') {
            const onStop = (): void => finish()
            if (wc.isDestroyed() || !wc.isLoading()) finish()
            else wc.once('did-stop-loading', onStop)
            return
          }
          finish(new Error(`페이지를 열 수 없습니다: ${e?.code ?? e?.message ?? e}`))
        }
      )
    })
  }

  private async extract(wc: WebContents, filter?: string): Promise<ListPageResult> {
    if (wc.isDestroyed()) throw new Error('창이 닫혔습니다')
    const script = `(${extractListPage.toString()})(${JSON.stringify({ filter: filter ?? '' })})`
    const r = (await wc.executeJavaScript(script, true)) as ListPageResult | null
    if (!r || !Array.isArray(r.items)) throw new Error('페이지에서 목록을 읽지 못했습니다')
    return {
      url: typeof r.url === 'string' ? r.url : wc.getURL(),
      title: typeof r.title === 'string' ? r.title : '',
      items: r.items.filter((i) => i && typeof i.url === 'string' && /^https?:\/\//i.test(i.url)).map((i) => ({ url: i.url, title: String(i.title ?? ''), thumb: typeof i.thumb === 'string' ? i.thumb : undefined, duration: typeof i.duration === 'string' ? i.duration : undefined })),
      total: typeof r.total === 'number' ? r.total : r.items.length,
      next: typeof r.next === 'string' && /^https?:\/\//i.test(r.next) ? r.next : null,
      challenge: !!r.challenge
    }
  }

  private wait(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(abortError())
      const t = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort)
        resolve()
      }, ms)
      const onAbort = (): void => {
        clearTimeout(t)
        reject(abortError())
      }
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  destroy(): void {
    const w = this.win
    this.win = null
    if (w && !w.isDestroyed()) {
      try {
        w.destroy()
      } catch {
        /* ignore */
      }
    }
  }
}
