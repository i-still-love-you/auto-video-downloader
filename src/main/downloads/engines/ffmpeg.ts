import { spawn } from 'node:child_process'
import readline from 'node:readline'
import { killTree } from '../../util'
import { abortError } from './types'

export interface FfmpegRun {
  ffmpeg: string
  inputs: string[]
  output: string
  extraArgs?: string[]
  durationSec?: number
  signal: AbortSignal
  onProgress?: (percent: number | null, outTimeSec: number) => void
}

/** 스트림 복사(리먹스/병합) 전용 ffmpeg 실행. */
export function runFfmpeg(o: FfmpegRun): Promise<void> {
  return new Promise((resolve, reject) => {
    if (o.signal.aborted) return reject(abortError())
    const args = ['-y', '-hide_banner', '-loglevel', 'error', '-nostats', '-progress', 'pipe:1']
    for (const i of o.inputs) args.push('-i', i)
    args.push('-map', '0')
    for (let i = 1; i < o.inputs.length; i++) args.push('-map', String(i))
    args.push('-c', 'copy', '-movflags', '+faststart', ...(o.extraArgs ?? []), o.output)
    const child = spawn(o.ffmpeg, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    let aborted = false
    const onAbort = (): void => {
      aborted = true
      killTree(child)
    }
    o.signal.addEventListener('abort', onAbort, { once: true })
    child.stderr?.on('data', (d) => {
      stderr += String(d)
      if (stderr.length > 20000) stderr = stderr.slice(-10000)
    })
    const rl = readline.createInterface({ input: child.stdout! })
    rl.on('line', (line) => {
      const m = /^out_time_us=(\d+)/.exec(line)
      if (m && o.onProgress) {
        const sec = Number(m[1]) / 1_000_000
        const pct = o.durationSec ? Math.min(99, (sec / o.durationSec) * 100) : null
        o.onProgress(pct, sec)
      }
    })
    child.on('error', (e) => {
      o.signal.removeEventListener('abort', onAbort)
      reject(new Error(`ffmpeg 실행 실패: ${e.message}`))
    })
    child.on('close', (code) => {
      o.signal.removeEventListener('abort', onAbort)
      if (aborted) return reject(abortError())
      if (code === 0) return resolve()
      reject(new Error(`ffmpeg 오류 (code ${code}): ${stderr.trim().split(/\r?\n/).slice(-3).join(' ')}`))
    })
  })
}

export function ffmpegDir(ffmpegPath: string): string {
  const idx = Math.max(ffmpegPath.lastIndexOf('/'), ffmpegPath.lastIndexOf('\\'))
  return idx >= 0 ? ffmpegPath.slice(0, idx) : ffmpegPath
}
