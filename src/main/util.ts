import { promises as fs, existsSync } from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { MEDIA_EXTENSIONS } from '@shared/types'

export function newId(): string {
  return crypto.randomBytes(8).toString('hex')
}

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

export function sanitizeFilename(name: string, max = 150): string {
  let out = name
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[. ]+|[. ]+$/g, '')
  if (!out || RESERVED.test(out)) out = `video_${Date.now()}`
  if (out.length > max) out = out.slice(0, max)
  return out
}

export function uniquePath(dir: string, base: string, ext: string): string {
  const cleanExt = ext ? (ext.startsWith('.') ? ext : `.${ext}`) : ''
  let candidate = path.join(dir, `${base}${cleanExt}`)
  let n = 1
  while (existsSync(candidate) || existsSync(`${candidate}.part`)) {
    candidate = path.join(dir, `${base} (${n})${cleanExt}`)
    n++
  }
  return candidate
}

export function parseContentDisposition(header: string | null | undefined): string | null {
  if (!header) return null
  const star = /filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i.exec(header)
  if (star) {
    try {
      return decodeURIComponent(star[2].trim().replace(/^"|"$/g, ''))
    } catch {
      /* ignore */
    }
  }
  const plain = /filename\s*=\s*("([^"]+)"|([^;]+))/i.exec(header)
  if (plain) return (plain[2] ?? plain[3]).trim()
  return null
}

const MIME_EXT: Record<string, string> = {
  'video/mp4': 'mp4',
  'application/mp4': 'mp4',
  'video/webm': 'webm',
  'video/x-matroska': 'mkv',
  'video/quicktime': 'mov',
  'video/x-flv': 'flv',
  'video/x-msvideo': 'avi',
  'video/x-ms-wmv': 'wmv',
  'video/x-ms-asf': 'asf',
  'video/3gpp': '3gp',
  'video/ogg': 'ogv',
  'video/mp2t': 'ts',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/ogg': 'ogg',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/flac': 'flac',
  'audio/webm': 'webm'
}

export function extFromMime(mime: string | null | undefined): string | null {
  if (!mime) return null
  const m = mime.split(';')[0].trim().toLowerCase()
  return MIME_EXT[m] ?? null
}

export function mimeFromExt(ext: string): string {
  const e = ext.replace(/^\./, '').toLowerCase()
  for (const [mime, x] of Object.entries(MIME_EXT)) if (x === e) return mime
  if (e === 'm3u8') return 'application/vnd.apple.mpegurl'
  if (e === 'mpd') return 'application/dash+xml'
  return 'application/octet-stream'
}

export function extOfUrl(url: string): string {
  try {
    const p = new URL(url).pathname
    const m = /\.([a-z0-9]{1,5})$/i.exec(p)
    return m ? m[1].toLowerCase() : ''
  } catch {
    return ''
  }
}

export function isMediaExt(ext: string): boolean {
  return MEDIA_EXTENSIONS.includes(ext.replace(/^\./, '').toLowerCase())
}

export function basenameOfUrl(url: string): string {
  try {
    const p = new URL(url).pathname
    const seg = p.split('/').filter(Boolean).pop() ?? ''
    return decodeURIComponent(seg)
  } catch {
    return ''
  }
}

export async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true })
}

export async function rmrf(target: string): Promise<void> {
  try {
    await fs.rm(target, { recursive: true, force: true, maxRetries: 3 })
  } catch {
    /* ignore */
  }
}

export async function fileSize(p: string): Promise<number> {
  try {
    return (await fs.stat(p)).size
  } catch {
    return 0
  }
}

export function killTree(child: ChildProcess): void {
  if (!child.pid) return
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    } catch {
      child.kill()
    }
  } else {
    try {
      process.kill(-child.pid, 'SIGTERM')
    } catch {
      child.kill('SIGTERM')
    }
  }
}

export function withTimeout<T>(p: Promise<T>, ms: number, message = '시간이 초과되었습니다'): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(message)), ms)
    p.then(
      (v) => {
        clearTimeout(t)
        resolve(v)
      },
      (e) => {
        clearTimeout(t)
        reject(e)
      }
    )
  })
}

export function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || /aborted/i.test(err.message))
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  let failed: unknown = null
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length && failed === null) {
      const i = next++
      try {
        results[i] = await fn(items[i], i)
      } catch (e) {
        failed = e
      }
    }
  })
  await Promise.all(workers)
  if (failed !== null) throw failed
  return results
}
