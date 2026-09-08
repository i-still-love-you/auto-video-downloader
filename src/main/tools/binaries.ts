import { app } from 'electron'
import { spawn, spawnSync } from 'node:child_process'
import { promises as fs, existsSync, createWriteStream } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { getSettings } from '../settings'
import { fetchMedia } from '../downloads/net'
import { ensureDir, rmrf } from '../util'
import type { ToolInstallProgress, ToolName, ToolStatus } from '@shared/types'

const EXE = process.platform === 'win32' ? '.exe' : ''
const BIN_NAMES: Record<ToolName, string> = { ytdlp: 'yt-dlp', ffmpeg: 'ffmpeg' }
const LABELS: Record<ToolName, string> = { ytdlp: 'yt-dlp', ffmpeg: 'ffmpeg' }

export function userBinDir(): string {
  return path.join(app.getPath('userData'), 'bin')
}

export function bundledBinDir(): string {
  return app.isPackaged ? path.join(process.resourcesPath, 'bin') : path.join(app.getAppPath(), 'resources', 'bin')
}

function whichSync(name: string): string | null {
  const cmd = process.platform === 'win32' ? 'where' : 'which'
  try {
    const r = spawnSync(cmd, [name], { encoding: 'utf8', windowsHide: true, timeout: 5000 })
    if (r.status !== 0) return null
    const first = r.stdout
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)[0]
    return first ?? null
  } catch {
    return null
  }
}

export function toolVersion(bin: string, name: ToolName): string | undefined {
  try {
    const args = name === 'ytdlp' ? ['--version'] : ['-version']
    const r = spawnSync(bin, args, { encoding: 'utf8', windowsHide: true, timeout: 10000 })
    const line = (r.stdout || '').split(/\r?\n/)[0]?.trim()
    if (!line) return undefined
    if (name === 'ffmpeg') {
      const m = /ffmpeg version (\S+)/.exec(line)
      return m ? m[1] : line
    }
    return line
  } catch {
    return undefined
  }
}

const cache = new Map<ToolName, { status: ToolStatus; at: number }>()

export async function findTool(name: ToolName, fresh = false): Promise<ToolStatus> {
  const c = cache.get(name)
  if (!fresh && c && Date.now() - c.at < 30_000) return c.status
  const bin = BIN_NAMES[name]
  const candidates: Array<{ p: string | undefined | null; source: ToolStatus['source'] }> = [
    { p: getSettings().toolPaths[name], source: 'settings' },
    { p: path.join(bundledBinDir(), bin + EXE), source: 'bundled' },
    { p: path.join(userBinDir(), bin + EXE), source: 'userData' },
    { p: whichSync(bin), source: 'path' }
  ]
  let status: ToolStatus = { name, found: false }
  for (const cand of candidates) {
    if (cand.p && existsSync(cand.p)) {
      status = { name, found: true, path: cand.p, source: cand.source, version: toolVersion(cand.p, name) }
      break
    }
  }
  cache.set(name, { status, at: Date.now() })
  return status
}

export async function toolPath(name: ToolName): Promise<string | undefined> {
  const s = await findTool(name)
  return s.found ? s.path : undefined
}

export async function requireTool(name: ToolName): Promise<string> {
  const p = await toolPath(name)
  if (!p) throw new Error(`${LABELS[name]}을(를) 찾을 수 없습니다. 설정 > 도구에서 설치해 주세요.`)
  return p
}

export async function toolsStatus(fresh = false): Promise<ToolStatus[]> {
  return Promise.all([findTool('ytdlp', fresh), findTool('ffmpeg', fresh)])
}

export function invalidateToolCache(): void {
  cache.clear()
}

// ---------- 도구 자동 설치 ----------

interface DownloadSpec {
  url: string
  kind: 'binary' | 'archive'
  pick: string[]
}

export function downloadSpec(name: ToolName): DownloadSpec {
  const platform = process.platform
  if (name === 'ytdlp') {
    const file = platform === 'win32' ? 'yt-dlp.exe' : platform === 'darwin' ? 'yt-dlp_macos' : 'yt-dlp'
    return { url: `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${file}`, kind: 'binary', pick: ['yt-dlp' + EXE] }
  }
  if (platform === 'win32') {
    return {
      url: 'https://github.com/BtbN/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-win64-gpl.zip',
      kind: 'archive',
      pick: ['ffmpeg.exe', 'ffprobe.exe']
    }
  }
  if (platform === 'darwin') {
    return { url: 'https://evermeet.cx/ffmpeg/getrelease/zip', kind: 'archive', pick: ['ffmpeg'] }
  }
  return {
    url: 'https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz',
    kind: 'archive',
    pick: ['ffmpeg', 'ffprobe']
  }
}

export async function installTool(
  name: ToolName,
  onProgress: (p: ToolInstallProgress) => void
): Promise<ToolStatus> {
  const spec = downloadSpec(name)
  const binDir = userBinDir()
  await ensureDir(binDir)
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vdl-tool-'))
  try {
    const archivePath = path.join(tmpDir, spec.kind === 'binary' ? spec.pick[0] : 'archive' + archiveExt(spec.url))
    await downloadToFile(spec.url, archivePath, (downloaded, total) =>
      onProgress({ name, stage: 'download', downloaded, total })
    )
    onProgress({ name, stage: 'extract', downloaded: 0, total: null })
    if (spec.kind === 'binary') {
      const dest = path.join(binDir, spec.pick[0])
      await fs.copyFile(archivePath, dest)
      if (process.platform !== 'win32') await fs.chmod(dest, 0o755)
    } else {
      const extractDir = path.join(tmpDir, 'x')
      await ensureDir(extractDir)
      await runTar(archivePath, extractDir)
      for (const want of spec.pick) {
        const found = await findFileRecursive(extractDir, want)
        if (!found) {
          if (want.startsWith('ffprobe')) continue
          throw new Error(`압축 파일에서 ${want}을(를) 찾지 못했습니다`)
        }
        const dest = path.join(binDir, want)
        await fs.copyFile(found, dest)
        if (process.platform !== 'win32') await fs.chmod(dest, 0o755)
      }
    }
    invalidateToolCache()
    const status = await findTool(name, true)
    onProgress({ name, stage: 'done', downloaded: 0, total: null })
    return status
  } catch (e) {
    onProgress({ name, stage: 'error', downloaded: 0, total: null, message: e instanceof Error ? e.message : String(e) })
    throw e
  } finally {
    await rmrf(tmpDir)
  }
}

function archiveExt(url: string): string {
  if (url.endsWith('.tar.xz')) return '.tar.xz'
  if (url.endsWith('.tar.gz')) return '.tar.gz'
  return '.zip'
}

async function downloadToFile(
  url: string,
  dest: string,
  onProgress: (downloaded: number, total: number | null) => void
): Promise<void> {
  const res = await fetchMedia(url, { timeoutMs: 30_000 })
  if (!res.ok || !res.body) throw new Error(`다운로드 실패 (HTTP ${res.status})`)
  const total = Number(res.headers.get('content-length')) || null
  let downloaded = 0
  let last = 0
  const out = createWriteStream(dest)
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      downloaded += chunk.length
      if (!out.write(chunk)) await new Promise<void>((r) => out.once('drain', () => r()))
      const now = Date.now()
      if (now - last > 200) {
        last = now
        onProgress(downloaded, total)
      }
    }
  } finally {
    await new Promise<void>((resolve, reject) => {
      out.end(() => resolve())
      out.on('error', reject)
    })
  }
  onProgress(downloaded, total)
}

function runTar(archive: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('tar', ['-xf', archive, '-C', dest], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
    let err = ''
    child.stderr?.on('data', (d) => (err += String(d)))
    child.on('error', (e) => reject(new Error(`tar 실행 실패: ${e.message}`)))
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`압축 해제 실패: ${err.trim() || code}`))))
  })
}

async function findFileRecursive(dir: string, name: string): Promise<string | null> {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  for (const e of entries) {
    const p = path.join(dir, e.name)
    if (e.isFile() && e.name === name) return p
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      const r = await findFileRecursive(path.join(dir, e.name), name)
      if (r) return r
    }
  }
  return null
}
