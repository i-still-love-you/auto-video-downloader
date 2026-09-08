/**
 * ffmpeg 가 없을 때의 대체 경로: 렌더러에서 <video> 로 프레임을 디코딩해 canvas 로 JPEG data URL 을 만든다.
 * Chromium 이 디코딩할 수 있는 형식(mp4/webm 등)에서만 동작한다.
 */
export function captureFrame(src: string, width = 320, timeoutMs = 15000): Promise<string | null> {
  return new Promise((resolve) => {
    const v = document.createElement('video')
    v.muted = true
    v.preload = 'auto'
    v.crossOrigin = 'anonymous'
    let done = false
    const finish = (result: string | null): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      v.removeAttribute('src')
      v.load()
      resolve(result)
    }
    const timer = setTimeout(() => finish(null), timeoutMs)
    v.addEventListener('error', () => finish(null))
    v.addEventListener('loadedmetadata', () => {
      const d = v.duration
      const t = Number.isFinite(d) && d > 0 ? Math.min(30, Math.max(0.5, d * 0.1)) : 1
      try {
        v.currentTime = t
      } catch {
        finish(null)
      }
    })
    v.addEventListener('seeked', () => {
      try {
        const ratio = v.videoWidth > 0 ? v.videoHeight / v.videoWidth : 9 / 16
        const c = document.createElement('canvas')
        c.width = width
        c.height = Math.max(1, Math.round(width * ratio))
        const g = c.getContext('2d')
        if (!g) return finish(null)
        g.drawImage(v, 0, 0, c.width, c.height)
        finish(c.toDataURL('image/jpeg', 0.8))
      } catch {
        finish(null)
      }
    })
    v.src = src
  })
}
