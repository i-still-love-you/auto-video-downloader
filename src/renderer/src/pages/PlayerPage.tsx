import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import Hls from 'hls.js'
import { useApp } from '../state/AppContext'
import { Icon } from '../components/Icon'

const RATES = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 3]

export function PlayerPage({ active }: { active: boolean }): React.JSX.Element {
  const { playerQueue, playerIndex, setPlayerIndex } = useApp()
  const videoRef = useRef<HTMLVideoElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const hlsRef = useRef<Hls | null>(null)
  const [rate, setRate] = useState(1)
  const [rotation, setRotation] = useState(0)
  const [loop, setLoop] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [stage, setStage] = useState({ w: 0, h: 0 })
  const item = playerQueue[playerIndex]

  useLayoutEffect(() => {
    const el = stageRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setStage({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    hlsRef.current?.destroy()
    hlsRef.current = null
    setError(null)
    if (!item) {
      v.removeAttribute('src')
      v.load()
      return
    }
    if (item.kind === 'hls' && Hls.isSupported()) {
      const hls = new Hls({ enableWorker: true, lowLatencyMode: false })
      hls.loadSource(item.src)
      hls.attachMedia(v)
      hls.on(Hls.Events.ERROR, (_e, data) => {
        if (data.fatal) setError(`재생 오류: ${data.details}`)
      })
      hlsRef.current = hls
    } else {
      v.src = item.src
    }
    v.playbackRate = rate
    void v.play().catch(() => undefined)
    return () => {
      hlsRef.current?.destroy()
      hlsRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item?.id, item?.src])

  useEffect(() => {
    if (videoRef.current) videoRef.current.playbackRate = rate
  }, [rate])

  useEffect(() => {
    if (!active) videoRef.current?.pause()
  }, [active])

  const next = useCallback(() => {
    if (!playerQueue.length) return
    if (playerIndex < playerQueue.length - 1) setPlayerIndex(playerIndex + 1)
    else if (loop) setPlayerIndex(0)
  }, [playerQueue.length, playerIndex, loop, setPlayerIndex])

  const prev = (): void => {
    if (playerIndex > 0) setPlayerIndex(playerIndex - 1)
  }

  const rotated = rotation % 180 !== 0
  const videoStyle: React.CSSProperties = rotated
    ? { width: stage.h || undefined, height: stage.w || undefined, transform: `rotate(${rotation}deg)` }
    : { transform: `rotate(${rotation}deg)` }

  return (
    <div className="player">
      <div className="player-main">
        <div ref={stageRef} className="player-stage" onDoubleClick={() => void stageRef.current?.requestFullscreen().catch(() => undefined)}>
          <video
            ref={videoRef}
            controls
            style={videoStyle}
            onEnded={() => (loop && playerQueue.length === 1 ? void videoRef.current?.play() : next())}
            onError={() => item && !hlsRef.current && setError('이 파일을 재생할 수 없습니다. 코덱을 지원하지 않을 수 있습니다. "기본 프로그램으로 열기"를 이용해 주세요.')}
          />
          {!item && (
            <div className="overlay">
              <div>
                <Icon name="play" size={40} />
                <p>파일 페이지나 브라우저의 감지 목록에서 재생할 항목을 선택하세요.</p>
              </div>
            </div>
          )}
          {error && (
            <div className="overlay">
              <div style={{ background: 'rgba(0,0,0,.7)', padding: 16, borderRadius: 8 }}>{error}</div>
            </div>
          )}
        </div>
        <div className="player-bar">
          <button className="icon-btn" onClick={prev} disabled={playerIndex <= 0} title="이전">
            <Icon name="back" />
          </button>
          <button className="icon-btn" onClick={next} disabled={playerIndex >= playerQueue.length - 1} title="다음">
            <Icon name="forward" />
          </button>
          <span className="now" title={item?.title}>
            {item ? item.title : '재생 중인 항목 없음'}
          </span>
          <label className="row small muted">
            배속
            <select className="select" value={rate} onChange={(e) => setRate(Number(e.target.value))}>
              {RATES.map((r) => (
                <option key={r} value={r}>
                  {r}x
                </option>
              ))}
            </select>
          </label>
          <button className="icon-btn" onClick={() => setRotation((r) => (r + 90) % 360)} title="화면 회전">
            <Icon name="rotate" />
          </button>
          <button className={`icon-btn ${loop ? 'active' : ''}`} onClick={() => setLoop(!loop)} title="반복 재생">
            <Icon name="reload" />
          </button>
          <button className="icon-btn" onClick={() => void stageRef.current?.requestFullscreen().catch(() => undefined)} title="전체 화면">
            <Icon name="fullscreen" />
          </button>
          {item?.path && (
            <button className="icon-btn" onClick={() => item.path && void window.api.files.open(item.path)} title="기본 프로그램으로 열기">
              <Icon name="open" />
            </button>
          )}
        </div>
      </div>
      <aside className="player-queue">
        <header>재생 목록 ({playerQueue.length})</header>
        <div className="list">
          {playerQueue.length === 0 ? (
            <div className="empty small">비어 있음</div>
          ) : (
            playerQueue.map((q, i) => (
              <div key={q.id} className={`list-item ${i === playerIndex ? 'active' : ''}`} onClick={() => setPlayerIndex(i)}>
                <Icon name={i === playerIndex ? 'play' : 'film'} size={14} className="muted" />
                <div className="title">
                  <div>{q.title}</div>
                  <div>{q.kind === 'local' ? '로컬 파일' : q.kind === 'hls' ? 'HLS 스트림' : '원격 파일'}</div>
                </div>
              </div>
            ))
          )}
        </div>
      </aside>
    </div>
  )
}
