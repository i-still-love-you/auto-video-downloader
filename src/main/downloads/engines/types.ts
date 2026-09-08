import type { DownloadProgress, DownloadTask, Settings } from '@shared/types'

export interface EngineContext {
  task: DownloadTask
  signal: AbortSignal
  workDir: string
  settings: Settings
  tools: { ffmpeg?: string; ytdlp?: string }
  onProgress(p: Partial<DownloadProgress>): void
  onFile(filePath: string): void
  log(line: string): void
}

export function abortError(): Error {
  const e = new Error('aborted')
  e.name = 'AbortError'
  return e
}

export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError()
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t)
        reject(abortError())
      },
      { once: true }
    )
  })
}
