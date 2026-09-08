import React, { useEffect, useRef, useState } from 'react'
import { Icon } from './Icon'
import { captureFrame } from '../lib/capture'

export type ThumbSource =
  | { kind: 'url'; url: string }
  | { kind: 'local'; path: string }
  | { kind: 'remote'; url: string; headers?: Record<string, string> }
  | { kind: 'vault'; id: string; hasThumb?: boolean }

const cache = new Map<string, Promise<string | null>>()
const failedAt = new Map<string, number>()
const RETRY_AFTER = 60_000

function keyOf(s: ThumbSource): string {
  switch (s.kind) {
    case 'url':
      return `url:${s.url}`
    case 'local':
      return `local:${s.path}`
    case 'remote':
      return `remote:${s.url}`
    case 'vault':
      return `vault:${s.id}`
  }
}

async function resolveSource(s: ThumbSource): Promise<string | null> {
  switch (s.kind) {
    case 'url':
      return s.url
    case 'local': {
      const r = await window.api.thumbnails.local(s.path)
      if (r.url) return r.url
      if (r.canFallback) {
        const data = await captureFrame(`media://local/?p=${encodeURIComponent(s.path)}`)
        if (data) {
          try {
            return await window.api.thumbnails.store(s.path, data)
          } catch {
            return data
          }
        }
      }
      return null
    }
    case 'remote':
      return window.api.thumbnails.remote(s.url, s.headers)
    case 'vault':
      return s.hasThumb === false ? null : window.api.vault.thumb(s.id)
  }
}

function load(s: ThumbSource): Promise<string | null> {
  const key = keyOf(s)
  const failed = failedAt.get(key)
  if (failed && Date.now() - failed < RETRY_AFTER) return Promise.resolve(null)
  let p = cache.get(key)
  if (!p) {
    p = resolveSource(s)
      .catch(() => null)
      .then((v) => {
        if (v === null) {
          cache.delete(key)
          failedAt.set(key, Date.now())
        }
        return v
      })
    cache.set(key, p)
  }
  return p
}

/** 특정 파일의 캐시된 썸네일을 잊는다 (이름 변경/삭제 후). */
export function forgetThumb(s: ThumbSource): void {
  const key = keyOf(s)
  cache.delete(key)
  failedAt.delete(key)
}

interface ThumbProps {
  source?: ThumbSource | null
  width?: number | string
  height?: number | string
  icon?: string
  iconSize?: number
  className?: string
  style?: React.CSSProperties
  title?: string
}

/** 화면에 보일 때만 썸네일을 요청하는 지연 로딩 이미지 */
export function Thumb({ source, width = 96, height = 54, icon = 'film', iconSize = 22, className, style, title }: ThumbProps): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(false)
  const [src, setSrc] = useState<string | null>(null)
  const [broken, setBroken] = useState(false)
  const key = source ? keyOf(source) : ''

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible(true)
          io.disconnect()
        }
      },
      { rootMargin: '200px' }
    )
    io.observe(el)
    return () => io.disconnect()
  }, [])

  useEffect(() => {
    setSrc(null)
    setBroken(false)
    if (!visible || !source) return
    let alive = true
    void load(source).then((v) => alive && setSrc(v))
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, key])

  return (
    <div ref={ref} className={`thumb ${className ?? ''}`} style={{ width, height, ...style }} title={title}>
      {src && !broken ? <img src={src} alt="" loading="lazy" onError={() => setBroken(true)} /> : <Icon name={icon} size={iconSize} />}
    </div>
  )
}
