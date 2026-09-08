import { app, protocol } from 'electron'
import { Readable } from 'node:stream'
import { createReadStream, promises as fs } from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { mimeFromExt } from './util'
import { fetchMedia } from './downloads/net'
import { getSettings } from './settings'

export const MEDIA_SCHEME = 'media'
export const PROXY_SCHEME = 'mproxy'

/** app ready 이전에 호출해야 한다. */
export function registerSchemes(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: MEDIA_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true, corsEnabled: true }
    },
    {
      scheme: PROXY_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true, corsEnabled: true }
    }
  ])
}

const extraRoots = new Set<string>()

export function allowMediaRoot(dir: string): void {
  extraRoots.add(path.resolve(dir))
}

export function mediaUrlFor(filePath: string): string {
  return `${MEDIA_SCHEME}://local/?p=${encodeURIComponent(path.resolve(filePath))}`
}

function isAllowed(abs: string): boolean {
  const roots = [getSettings().downloadDir, getSettings().vaultDir, path.join(app.getPath('temp'), 'vdl-vault'), ...extraRoots]
  return roots.some((root) => {
    const rel = path.relative(path.resolve(root), abs)
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
  })
}

const proxyHeaders = new Map<string, Record<string, string>>()

export function proxyUrlFor(url: string, headers: Record<string, string> = {}): string {
  const token = crypto.createHash('sha1').update(JSON.stringify(headers)).digest('hex').slice(0, 16)
  proxyHeaders.set(token, headers)
  return `${PROXY_SCHEME}://r/?u=${encodeURIComponent(url)}&t=${token}`
}

function toWeb(stream: NodeJS.ReadableStream): ReadableStream {
  return Readable.toWeb(stream as Readable) as unknown as ReadableStream
}

async function handleMedia(req: Request): Promise<Response> {
  const u = new URL(req.url)
  const p = u.searchParams.get('p')
  if (!p) return new Response('bad request', { status: 400 })
  const abs = path.resolve(p)
  if (!isAllowed(abs)) return new Response('forbidden', { status: 403 })
  let size: number
  try {
    size = (await fs.stat(abs)).size
  } catch {
    return new Response('not found', { status: 404 })
  }
  const mime = mimeFromExt(path.extname(abs))
  const common: Record<string, string> = {
    'Accept-Ranges': 'bytes',
    'Content-Type': mime,
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store'
  }
  const range = req.headers.get('range')
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range)
    if (m) {
      let start = m[1] ? Number(m[1]) : 0
      let end = m[2] ? Number(m[2]) : size - 1
      if (!m[1] && m[2]) {
        start = Math.max(0, size - Number(m[2]))
        end = size - 1
      }
      if (start >= size) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } })
      end = Math.min(end, size - 1)
      const headers = { ...common, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(end - start + 1) }
      if (req.method === 'HEAD') return new Response(null, { status: 206, headers })
      return new Response(toWeb(createReadStream(abs, { start, end })), { status: 206, headers })
    }
  }
  const headers = { ...common, 'Content-Length': String(size) }
  if (req.method === 'HEAD') return new Response(null, { status: 200, headers })
  return new Response(toWeb(createReadStream(abs)), { status: 200, headers })
}

function rewritePlaylist(text: string, baseUrl: string, token: string | null): string {
  const proxied = (uri: string): string => {
    let abs = uri
    try {
      abs = new URL(uri, baseUrl).href
    } catch {
      /* ignore */
    }
    return `${PROXY_SCHEME}://r/?u=${encodeURIComponent(abs)}${token ? `&t=${token}` : ''}`
  }
  return text
    .split(/\r?\n/)
    .map((line) => {
      const t = line.trim()
      if (!t) return line
      if (t.startsWith('#')) return t.replace(/URI="([^"]+)"/g, (_m, uri: string) => `URI="${proxied(uri)}"`)
      return proxied(t)
    })
    .join('\n')
}

async function handleProxy(req: Request): Promise<Response> {
  const u = new URL(req.url)
  const target = u.searchParams.get('u')
  const token = u.searchParams.get('t')
  if (!target || !/^https?:\/\//i.test(target)) return new Response('bad request', { status: 400 })
  const headers = (token && proxyHeaders.get(token)) || {}
  const range = req.headers.get('range') ?? undefined
  let res: Response
  try {
    res = await fetchMedia(target, { headers, range, method: req.method === 'HEAD' ? 'HEAD' : 'GET' })
  } catch (e) {
    return new Response(`upstream error: ${e instanceof Error ? e.message : e}`, { status: 502 })
  }
  const ct = res.headers.get('content-type') ?? ''
  const isPlaylist = /mpegurl/i.test(ct) || /\.m3u8(\?|$)/i.test(target)
  const out: Record<string, string> = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Expose-Headers': '*',
    'Content-Type': ct || 'application/octet-stream',
    'Cache-Control': 'no-store'
  }
  if (isPlaylist && res.ok) {
    const text = await res.text()
    return new Response(rewritePlaylist(text, res.url || target, token), {
      status: 200,
      headers: { ...out, 'Content-Type': 'application/vnd.apple.mpegurl' }
    })
  }
  for (const h of ['content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag']) {
    const v = res.headers.get(h)
    if (v) out[h] = v
  }
  if (req.method === 'HEAD') return new Response(null, { status: res.status, headers: out })
  return new Response(res.body, { status: res.status, headers: out })
}

export function installProtocols(): void {
  protocol.handle(MEDIA_SCHEME, (req) => handleMedia(req).catch((e) => new Response(String(e), { status: 500 })))
  protocol.handle(PROXY_SCHEME, (req) => handleProxy(req).catch((e) => new Response(String(e), { status: 500 })))
}
