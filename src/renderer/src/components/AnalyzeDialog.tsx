import React, { useCallback, useEffect, useMemo, useState } from 'react'
import type { AnalyzeResult, HlsVariant, YtdlpFormat } from '@shared/types'
import { useApp } from '../state/AppContext'
import { useDownloads } from '../hooks/useDownloads'
import { Modal } from './Modal'
import { Icon } from './Icon'
import { Thumb } from './Thumb'
import { errorText, formatBytes, formatDuration, hostOf } from '../lib/format'

function variantHeight(v: HlsVariant): number {
  const m = /(\d+)x(\d+)/.exec(v.resolution ?? '')
  return m ? Number(m[2]) : 0
}

function variantLabel(v: HlsVariant): string {
  const parts: string[] = []
  if (v.resolution) parts.push(v.resolution)
  if (v.frameRate) parts.push(`${Math.round(v.frameRate)}fps`)
  if (v.bandwidth) parts.push(`${Math.round(v.bandwidth / 1000)} kbps`)
  if (v.codecs) parts.push(v.codecs)
  if (v.name) parts.push(v.name)
  if (v.audioUri) parts.push('별도 오디오')
  return parts.join(' · ') || v.uri
}

function formatLabel(f: YtdlpFormat): string {
  const parts: string[] = []
  if (f.resolution) parts.push(f.resolution)
  if (f.fps) parts.push(`${Math.round(f.fps)}fps`)
  if (f.ext) parts.push(f.ext)
  if (f.vcodec && f.vcodec !== 'none') parts.push(f.vcodec.split('.')[0])
  if (f.acodec && f.acodec !== 'none') parts.push(f.acodec.split('.')[0])
  if (f.tbr) parts.push(`${Math.round(f.tbr)}k`)
  if (f.note) parts.push(f.note)
  return parts.join(' · ')
}

export function AnalyzeDialog(): React.JSX.Element | null {
  const { analyzeRequest: req, closeAnalyze, toast, play, setPage } = useApp()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<AnalyzeResult | null>(null)
  const [selection, setSelection] = useState('')
  const [filename, setFilename] = useState('')
  const [starting, setStarting] = useState(false)
  const tasks = useDownloads()
  const existing = useMemo(() => {
    if (!result) return undefined
    return tasks.find((t) => t.url === result.url && t.status === 'completed') ?? tasks.find((t) => t.url === result.url && (t.status === 'running' || t.status === 'queued' || t.status === 'paused'))
  }, [tasks, result])

  useEffect(() => {
    if (!req) return
    let alive = true
    setLoading(true)
    setError(null)
    setResult(null)
    setSelection('')
    const p = req.item
      ? window.api.downloads.analyzeDetected(req.item)
      : window.api.downloads.analyze(req.url, req.headers, req.pageUrl, req.pageTitle)
    p.then((r) => {
      if (!alive) return
      setResult(r)
      setFilename(r.title)
    })
      .catch((e) => alive && setError(errorText(e)))
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [req])

  const groups = useMemo(() => {
    const formats = result?.formats ?? []
    return {
      both: formats.filter((f) => f.hasVideo && f.hasAudio),
      video: formats.filter((f) => f.hasVideo && !f.hasAudio),
      audio: formats.filter((f) => !f.hasVideo && f.hasAudio)
    }
  }, [result])

  const start = useCallback(async () => {
    if (!result) return
    setStarting(true)
    try {
      await window.api.downloads.enqueue({ analyze: result, selection: selection || undefined, filename: filename.trim() || undefined })
      toast({ type: 'success', message: `다운로드를 추가했습니다: ${filename || result.title}` })
      closeAnalyze()
    } catch (e) {
      toast({ type: 'error', message: errorText(e) })
    } finally {
      setStarting(false)
    }
  }, [result, selection, filename, toast, closeAnalyze])

  const playOnline = useCallback(async () => {
    if (!result) return
    try {
      let url = result.url
      let kind: 'hls' | 'remote' = result.kind === 'hls' ? 'hls' : 'remote'
      if (result.kind === 'ytdlp') {
        const cands = (result.formats ?? []).filter((f) => f.url && f.hasVideo && f.hasAudio)
        const pick =
          cands.find((f) => /m3u8/i.test(f.protocol ?? '')) ??
          cands.find((f) => /^https?/i.test(f.protocol ?? '') && f.ext === 'mp4') ??
          cands[0]
        if (!pick?.url) throw new Error('온라인 재생이 가능한 형식을 찾지 못했습니다. 다운로드 후 재생해 주세요.')
        url = pick.url
        kind = /m3u8/i.test(pick.protocol ?? '') || /\.m3u8/i.test(url) ? 'hls' : 'remote'
      }
      const src = await window.api.player.proxyUrl(url, result.headers)
      play({ id: `online:${url}`, title: result.title, src, kind })
      closeAnalyze()
    } catch (e) {
      toast({ type: 'error', message: errorText(e) })
    }
  }, [result, play, closeAnalyze, toast])

  if (!req) return null

  const kindLabel = result?.kind === 'hls' ? 'HLS' : result?.kind === 'file' ? '직접 파일' : result?.extractor ?? 'yt-dlp'

  return (
    <Modal
      title="다운로드 준비"
      onClose={closeAnalyze}
      width={640}
      footer={
        <>
          {result && (result.kind !== 'ytdlp' || groups.both.some((f) => f.url)) && (
            <button className="btn" onClick={playOnline} style={{ marginRight: 'auto' }}>
              <Icon name="play" size={14} /> 온라인 재생
            </button>
          )}
          <button className="btn" onClick={closeAnalyze}>
            취소
          </button>
          <button className="btn primary" disabled={!result || starting} onClick={start}>
            <Icon name="download" size={14} /> 다운로드 시작
          </button>
        </>
      }
    >
      <div className="muted small ellipsis" title={req.url}>
        {req.url}
      </div>
      {loading && (
        <div className="empty">
          <div className="progress indeterminate" style={{ width: 200, margin: '0 auto 12px' }}>
            <div />
          </div>
          분석 중입니다...
        </div>
      )}
      {error && (
        <div className="mt-16">
          <p style={{ color: 'var(--danger)' }}>{error}</p>
          {/설치|찾을 수 없습니다/.test(error) && (
            <button
              className="btn"
              onClick={() => {
                closeAnalyze()
                setPage('settings')
              }}
            >
              설정으로 이동
            </button>
          )}
        </div>
      )}
      {result && (
        <div className="mt-8">
          {existing && (
            <div className={`dl-badge ${existing.status === 'completed' ? 'done' : 'progress'}`} style={{ marginBottom: 10 }}>
              <Icon name={existing.status === 'completed' ? 'checkCircle' : 'download'} size={13} />
              {existing.status === 'completed' ? `이미 다운로드한 항목입니다: ${existing.filePath ?? existing.title}` : '이미 다운로드 목록에 있는 항목입니다'}
            </div>
          )}
          <div className="analyze-head">
            <Thumb
              source={result.thumbnail ? { kind: 'url', url: result.thumbnail } : result.kind !== 'ytdlp' ? { kind: 'remote', url: result.url, headers: result.headers } : null}
              width={160}
              height={90}
              iconSize={28}
            />
            <div className="info">
              <div>
                <span className={`kind ${result.kind}`}>{kindLabel}</span>
                <span className="muted small">{hostOf(result.url)}</span>
              </div>
              <div className="muted small mt-8">
                {result.duration ? `길이 ${formatDuration(result.duration)} · ` : ''}
                {result.size ? `크기 ${formatBytes(result.size)} · ` : ''}
                {result.mime ?? ''}
              </div>
            </div>
          </div>
          <div className="field">
            <label className="field-label">파일 이름 (확장자 제외)</label>
            <input className="input" value={filename} onChange={(e) => setFilename(e.target.value)} />
          </div>

          {result.kind === 'hls' && result.variants && result.variants.length > 0 && (
            <div className="field">
              <label className="field-label">화질 선택</label>
              <div className="option-list">
                <label className={selection === '' ? 'checked' : ''}>
                  <input type="radio" name="sel" checked={selection === ''} onChange={() => setSelection('')} />
                  <span className="desc">자동 (설정의 기본 화질)</span>
                </label>
                {result.variants.map((v, i) => (
                  <label key={i} className={selection === String(i) ? 'checked' : ''}>
                    <input type="radio" name="sel" checked={selection === String(i)} onChange={() => setSelection(String(i))} />
                    <span className="desc">{variantLabel(v)}</span>
                    {variantHeight(v) > 0 && <span className="size">{variantHeight(v)}p</span>}
                  </label>
                ))}
              </div>
            </div>
          )}

          {result.kind === 'ytdlp' && (
            <div className="field">
              <label className="field-label">형식 선택</label>
              <div className="option-list">
                <label className={selection === '' ? 'checked' : ''}>
                  <input type="radio" name="sel" checked={selection === ''} onChange={() => setSelection('')} />
                  <span className="desc">자동 (최고 화질 영상 + 음성 병합)</span>
                </label>
                {(['both', 'video', 'audio'] as const).map((g) =>
                  groups[g].length ? (
                    <React.Fragment key={g}>
                      <div className="group">{g === 'both' ? '영상 + 음성' : g === 'video' ? '영상만 (음성 자동 병합)' : '음성만'}</div>
                      {groups[g].map((f) => (
                        <label key={f.formatId} className={selection === f.formatId ? 'checked' : ''}>
                          <input type="radio" name="sel" checked={selection === f.formatId} onChange={() => setSelection(f.formatId)} />
                          <span className="desc">{formatLabel(f)}</span>
                          <span className="size">{formatBytes(f.filesize)}</span>
                        </label>
                      ))}
                    </React.Fragment>
                  ) : null
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </Modal>
  )
}
