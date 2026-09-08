import type { DetectedMedia } from '@shared/types'
import { fetchMedia } from '../downloads/net'
import { fetchText, heightOf, parsePlaylist } from '../downloads/engines/hls'
import { errorMessage } from '../util'

const CONCURRENCY = 3
const TIMEOUT = 15_000

function totalFromHeaders(res: Response): number | null {
  const cr = res.headers.get('content-range')
  const m = cr ? /\/(\d+)\s*$/.exec(cr) : null
  if (m) return Number(m[1])
  const cl = res.headers.get('content-length')
  return cl && /^\d+$/.test(cl) && res.status !== 206 ? Number(cl) : null
}

/**
 * 감지 항목의 사전 조회. 네트워크로 잡히지 않은(스캔) 파일은 Range 0-0 요청으로 크기·형식·접근 가능 여부를,
 * HLS 는 재생목록을 읽어 길이·최고 화질·예상 용량을 채운다. 동시 3개까지만 처리한다.
 */
export class Prober {
  private queue: DetectedMedia[] = []
  private active = 0

  constructor(private readonly onUpdate: (item: DetectedMedia) => void) {}

  enqueue(item: DetectedMedia): void {
    if (item.probe) return
    item.probe = { status: 'pending' }
    this.queue.push(item)
    this.pump()
  }

  private pump(): void {
    while (this.active < CONCURRENCY && this.queue.length) {
      const item = this.queue.shift()!
      this.active++
      void this.run(item).finally(() => {
        this.active--
        this.pump()
      })
    }
  }

  private async run(item: DetectedMedia): Promise<void> {
    try {
      if (item.kind === 'hls') await this.probeHls(item)
      else await this.probeFile(item)
      if (item.probe?.status === 'pending') item.probe = { status: 'ok' }
    } catch (e) {
      item.probe = { status: 'error', message: errorMessage(e) }
    }
    this.onUpdate(item)
  }

  private async probeFile(item: DetectedMedia): Promise<void> {
    const res = await fetchMedia(item.url, { headers: item.headers, range: 'bytes=0-0', timeoutMs: TIMEOUT })
    await res.body?.cancel().catch(() => undefined)
    if (!res.ok) {
      item.probe = { status: 'error', httpStatus: res.status, message: res.status === 403 || res.status === 401 ? '접근 권한 없음' : res.status === 404 || res.status === 410 ? '주소가 만료되었거나 없음' : `HTTP ${res.status}` }
      return
    }
    const mime = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
    if (/^text\/html/.test(mime)) {
      item.probe = { status: 'error', httpStatus: res.status, message: '동영상이 아닌 웹 페이지' }
      return
    }
    if (/mpegurl/.test(mime)) {
      item.kind = 'hls'
      item.mime = mime
      await this.probeHls(item)
      return
    }
    const size = totalFromHeaders(res)
    if (size !== null) item.size = size
    if (mime && (mime.startsWith('video/') || mime.startsWith('audio/') || mime === 'application/mp4')) item.mime = mime
    item.probe = { status: 'ok', httpStatus: res.status }
  }

  private async probeHls(item: DetectedMedia): Promise<void> {
    const parsed = parsePlaylist(await fetchText(item.url, item.headers), item.url)
    if (parsed.type === 'master') {
      item.variantCount = parsed.variants.length
      const best = [...parsed.variants].sort((a, b) => heightOf(b) - heightOf(a) || b.bandwidth - a.bandwidth)[0]
      if (!best) return
      item.resolution = best.resolution
      const media = parsePlaylist(await fetchText(best.uri, item.headers), best.uri)
      if (media.type !== 'media') return
      item.live = media.live
      item.duration = media.totalDuration
      if (best.bandwidth && media.totalDuration) item.estimatedSize = Math.round((best.bandwidth / 8) * media.totalDuration)
      if (media.live) item.probe = { status: 'error', message: '라이브 스트림 (다운로드 불가)' }
      return
    }
    item.live = parsed.live
    item.duration = parsed.totalDuration
    if (parsed.live) {
      item.probe = { status: 'error', message: '라이브 스트림 (다운로드 불가)' }
      return
    }
    // 변형 정보가 없는 미디어 재생목록: 첫 세그먼트 크기 × 세그먼트 수로 대략 추정
    const seg = parsed.segments[0]
    if (seg && !seg.byterange) {
      try {
        const res = await fetchMedia(seg.uri, { headers: item.headers, range: 'bytes=0-0', timeoutMs: TIMEOUT })
        await res.body?.cancel().catch(() => undefined)
        const total = totalFromHeaders(res)
        if (res.ok && total) item.estimatedSize = Math.round(total * parsed.segments.length)
      } catch {
        /* 추정 실패는 무시 */
      }
    }
  }
}
