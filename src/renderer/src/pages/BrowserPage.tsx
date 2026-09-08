import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { AdblockStatus, AdblockTabStats, Bookmark, BrowserState, DetectedMedia, HistoryEntry, PopupStats, TabState } from '@shared/types'
import { SEARCH_ENGINES } from '@shared/types'
import { useApp } from '../state/AppContext'
import { useDownloads } from '../hooks/useDownloads'
import { Icon } from '../components/Icon'
import { useConfirm } from '../components/Modal'
import { Thumb } from '../components/Thumb'
import { errorText, formatBytes, formatDate, hostOf } from '../lib/format'

type Panel = 'none' | 'detected' | 'bookmarks' | 'history' | 'adblock'

const PANEL_TITLE: Record<Exclude<Panel, 'none'>, string> = {
  detected: '감지된 동영상',
  bookmarks: '즐겨찾기',
  history: '방문 기록',
  adblock: '광고 차단'
}

export function BrowserPage(): React.JSX.Element {
  const { settings, saveSettings, requestAnalyze, play, toast, focusAddressToken, page, setPage } = useApp()
  const [adblock, setAdblock] = useState<AdblockStatus | null>(null)
  const [tabStats, setTabStats] = useState<AdblockTabStats | null>(null)
  const [popupStats, setPopupStats] = useState<PopupStats | null>(null)
  const [popupTick, setPopupTick] = useState(0)
  const [quickBusy, setQuickBusy] = useState<Set<string>>(new Set())
  const tasks = useDownloads()
  const taskByUrl = useMemo(() => {
    const m = new Map<string, (typeof tasks)[number]>()
    for (const t of tasks) {
      const prev = m.get(t.url)
      if (!prev || t.status === 'completed' || (prev.status !== 'completed' && t.createdAt > prev.createdAt)) m.set(t.url, t)
    }
    return m
  }, [tasks])

  const quickDownload = async (item: DetectedMedia): Promise<void> => {
    setQuickBusy((s) => new Set(s).add(item.id))
    try {
      const t = await window.api.downloads.quick(item)
      toast({ type: 'success', message: `바로 받기 시작: ${t.title}` })
    } catch (e) {
      toast({ type: 'error', message: errorText(e) })
    } finally {
      setQuickBusy((s) => {
        const n = new Set(s)
        n.delete(item.id)
        return n
      })
    }
  }
  const [state, setState] = useState<BrowserState>({ tabs: [], activeTabId: null })
  const [detected, setDetected] = useState<Record<number, DetectedMedia[]>>({})
  const [panel, setPanel] = useState<Panel>('none')
  const [address, setAddress] = useState('')
  const [editing, setEditing] = useState(false)
  const [newTabQuery, setNewTabQuery] = useState('')
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([])
  const [history, setHistory] = useState<HistoryEntry[]>([])
  const [historyQuery, setHistoryQuery] = useState('')
  const addressRef = useRef<HTMLInputElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const [confirm, confirmDialog] = useConfirm()

  const active: TabState | undefined = useMemo(() => state.tabs.find((t) => t.id === state.activeTabId), [state])
  const activeDetected = active ? (detected[active.id] ?? []) : []
  const isBookmarked = !!active?.url && bookmarks.some((b) => b.url === active.url)

  const loadBookmarks = useCallback(() => void window.api.bookmarks.list().then(setBookmarks), [])
  const loadHistory = useCallback((q: string) => void window.api.history.list(q, 300).then(setHistory), [])

  useEffect(() => {
    void window.api.browser.getState().then((s) => {
      setState(s)
      if (!s.tabs.length) void window.api.browser.newTab()
    })
    const offState = window.api.browser.onState(setState)
    const offDetected = window.api.browser.onDetected((item) =>
      setDetected((prev) => ({ ...prev, [item.tabId]: [...(prev[item.tabId] ?? []).filter((x) => x.url !== item.url), item] }))
    )
    loadBookmarks()
    return () => {
      offState()
      offDetected()
    }
  }, [loadBookmarks])

  useEffect(() => {
    if (!active) return
    const id = active.id
    void window.api.browser.getDetected(id).then((list) => setDetected((prev) => ({ ...prev, [id]: list })))
  }, [active?.id, active?.url])

  useEffect(() => {
    setEditing(false)
    setNewTabQuery('')
    addressRef.current?.blur()
  }, [active?.id])

  useEffect(() => {
    if (!editing) setAddress(active?.url ?? '')
  }, [active?.url, active?.id, editing])

  useEffect(() => {
    if (focusAddressToken > 0) {
      addressRef.current?.focus()
      addressRef.current?.select()
    }
  }, [focusAddressToken])

  useEffect(() => {
    if (panel === 'history') loadHistory(historyQuery)
    if (panel === 'bookmarks') loadBookmarks()
  }, [panel, historyQuery, loadHistory, loadBookmarks])

  useEffect(() => {
    void window.api.adblock.status().then(setAdblock)
    return window.api.adblock.onStatus(setAdblock)
  }, [])

  useEffect(() => {
    if (panel !== 'adblock' || !active) {
      setTabStats(null)
      return
    }
    let alive = true
    void window.api.adblock.tabStats(active.id).then((s) => alive && setTabStats(s))
    void window.api.adblock.status().then((s) => alive && setAdblock(s))
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panel, active?.id, active?.url, active?.blockedCount])

  const toggleSite = async (): Promise<void> => {
    if (!tabStats?.host || !active) return
    await window.api.adblock.setAllowed(tabStats.host, !tabStats.allowed)
    setTabStats(await window.api.adblock.tabStats(active.id))
    void window.api.browser.reload(active.id)
  }

  useEffect(() => window.api.browser.onPopupBlocked(() => setPopupTick((t) => t + 1)), [])

  useEffect(() => {
    if (panel !== 'adblock' || !active) {
      setPopupStats(null)
      return
    }
    let alive = true
    void window.api.browser.popupStats(active.id).then((s) => alive && setPopupStats(s))
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panel, active?.id, active?.url, popupTick])

  const refreshPopupStats = async (): Promise<void> => {
    if (active) setPopupStats(await window.api.browser.popupStats(active.id))
  }

  useLayoutEffect(() => {
    const el = contentRef.current
    if (!el) return
    const send = (): void => {
      const r = el.getBoundingClientRect()
      window.api.browser.setBounds({ x: r.left, y: r.top, width: r.width, height: r.height })
    }
    send()
    const ro = new ResizeObserver(send)
    ro.observe(el)
    window.addEventListener('resize', send)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', send)
    }
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (page !== 'browser') return
      const mod = e.ctrlKey || e.metaKey
      if (mod && e.shiftKey && e.key.toLowerCase() === 't') {
        e.preventDefault()
        void window.api.browser.reopenClosedTab()
      } else if (mod && e.key.toLowerCase() === 't') {
        e.preventDefault()
        void window.api.browser.newTab().then(() => addressRef.current?.focus())
      } else if (mod && !e.shiftKey && !e.altKey && /^[1-9]$/.test(e.key)) {
        e.preventDefault()
        void window.api.browser.activateIndex(Number(e.key))
      } else if (mod && e.key.toLowerCase() === 'w' && active) {
        e.preventDefault()
        void window.api.browser.closeTab(active.id)
      } else if (mod && e.key.toLowerCase() === 'l') {
        e.preventDefault()
        addressRef.current?.focus()
        addressRef.current?.select()
      } else if ((mod && e.key.toLowerCase() === 'r') || e.key === 'F5') {
        if (active?.url) {
          e.preventDefault()
          void window.api.browser.reload(active.id)
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [page, active])

  const submitAddress = (e: React.FormEvent): void => {
    e.preventDefault()
    if (!active) return
    const value = address.trim()
    if (!value) return
    void window.api.browser.navigate(active.id, value)
    setEditing(false)
    addressRef.current?.blur()
  }

  const submitNewTab = (e: React.FormEvent): void => {
    e.preventDefault()
    if (!active) return
    const value = newTabQuery.trim()
    if (!value) return
    void window.api.browser.navigate(active.id, value)
    setNewTabQuery('')
  }

  const toggleBookmark = async (): Promise<void> => {
    if (!active?.url) return
    if (isBookmarked) {
      const b = bookmarks.find((x) => x.url === active.url)
      if (b) await window.api.bookmarks.remove(b.id)
      toast({ type: 'info', message: '즐겨찾기에서 제거했습니다' })
    } else {
      await window.api.bookmarks.add(active.url, active.title)
      toast({ type: 'success', message: '즐겨찾기에 추가했습니다' })
    }
    loadBookmarks()
  }

  const playDetected = async (item: DetectedMedia): Promise<void> => {
    try {
      const src = await window.api.player.proxyUrl(item.url, item.headers)
      play({ id: `online:${item.url}`, title: item.filename || item.pageTitle || hostOf(item.url), src, kind: item.kind === 'hls' ? 'hls' : 'remote' })
    } catch (e) {
      toast({ type: 'error', message: errorText(e) })
    }
  }

  const engine = SEARCH_ENGINES.find((e) => e.id === settings?.searchEngineId) ?? SEARCH_ENGINES[0]

  return (
    <div className="browser">
      <div className="tabstrip">
        {state.tabs.map((t) => (
          <div
            key={t.id}
            className={`tab ${t.id === state.activeTabId ? 'active' : ''}`}
            onClick={() => void window.api.browser.activateTab(t.id)}
            onAuxClick={(e) => {
              if (e.button === 1) void window.api.browser.closeTab(t.id)
            }}
            onContextMenu={(e) => {
              e.preventDefault()
              void window.api.browser.tabMenu(t.id)
            }}
            title={t.url || '새 탭'}
          >
            {t.loading ? <Icon name="reload" size={14} /> : t.favicon ? <img src={t.favicon} alt="" /> : <Icon name="globe" size={14} />}
            <span className="title">{t.title || t.url || '새 탭'}</span>
            {t.detectedCount > 0 && <span className="count">{t.detectedCount}</span>}
            <button
              className="close"
              onClick={(e) => {
                e.stopPropagation()
                void window.api.browser.closeTab(t.id)
              }}
              title="탭 닫기"
            >
              <Icon name="close" size={12} />
            </button>
          </div>
        ))}
        <button className="icon-btn tab-new" onClick={() => void window.api.browser.newTab().then(() => addressRef.current?.focus())} title="새 탭 (Ctrl+T)">
          <Icon name="plus" />
        </button>
      </div>

      <div className="navbar">
        <button className="icon-btn" disabled={!active?.canGoBack} onClick={() => active && void window.api.browser.goBack(active.id)} title="뒤로">
          <Icon name="back" />
        </button>
        <button className="icon-btn" disabled={!active?.canGoForward} onClick={() => active && void window.api.browser.goForward(active.id)} title="앞으로">
          <Icon name="forward" />
        </button>
        <button
          className="icon-btn"
          disabled={!active?.url}
          onClick={() => active && void (active.loading ? window.api.browser.stop(active.id) : window.api.browser.reload(active.id))}
          title={active?.loading ? '중지' : '새로고침'}
        >
          <Icon name={active?.loading ? 'close' : 'reload'} />
        </button>
        <form className="address" onSubmit={submitAddress}>
          <Icon name={/^https:/.test(active?.url ?? '') ? 'lock' : 'search'} size={14} className="muted" />
          <input
            ref={addressRef}
            value={address}
            placeholder={`주소를 입력하거나 ${engine.name}에서 검색`}
            onChange={(e) => setAddress(e.target.value)}
            onFocus={(e) => {
              setEditing(true)
              e.target.select()
            }}
            onBlur={() => setEditing(false)}
            spellCheck={false}
          />
        </form>
        <button className={`icon-btn ${isBookmarked ? 'active' : ''}`} disabled={!active?.url} onClick={() => void toggleBookmark()} title="즐겨찾기 (Ctrl+D)">
          <Icon name={isBookmarked ? 'star' : 'starOutline'} />
        </button>
        <button
          className={`icon-btn ${panel === 'adblock' ? 'active' : ''}`}
          onClick={() => setPanel(panel === 'adblock' ? 'none' : 'adblock')}
          title={adblock?.enabled ? '광고 차단 (켜짐)' : '광고 차단 (꺼짐)'}
          style={adblock && !adblock.enabled ? { opacity: 0.45 } : undefined}
        >
          <Icon name="shield" />
          {adblock?.enabled && (active?.blockedCount ?? 0) > 0 && <span className="dot ok">{active!.blockedCount}</span>}
        </button>
        <button
          className={`icon-btn ${panel === 'detected' ? 'active' : ''}`}
          onClick={() => setPanel(panel === 'detected' ? 'none' : 'detected')}
          title="감지된 동영상"
        >
          <Icon name="download" />
          {activeDetected.length > 0 && <span className="dot">{activeDetected.length}</span>}
        </button>
        <button className={`icon-btn ${panel === 'bookmarks' ? 'active' : ''}`} onClick={() => setPanel(panel === 'bookmarks' ? 'none' : 'bookmarks')} title="즐겨찾기 목록">
          <Icon name="list" />
        </button>
        <button className={`icon-btn ${panel === 'history' ? 'active' : ''}`} onClick={() => setPanel(panel === 'history' ? 'none' : 'history')} title="방문 기록">
          <Icon name="history" />
        </button>
      </div>

      <div className="browser-main">
        <div ref={contentRef} className={`browser-content ${active && !active.url ? 'blank' : ''}`}>
          {active && !active.url && (
            <div className="newtab">
              <h1>어디로 갈까요?</h1>
              <form className="address" onSubmit={submitNewTab} style={{ width: 'min(640px, 80%)' }}>
                <Icon name="search" size={16} className="muted" />
                <input value={newTabQuery} placeholder={`${engine.name} 검색 또는 주소 입력`} onChange={(e) => setNewTabQuery(e.target.value)} autoFocus />
              </form>
              <div className="engine-chips">
                {SEARCH_ENGINES.map((e) => (
                  <button key={e.id} className={`chip ${e.id === engine.id ? 'active' : ''}`} onClick={() => void saveSettings({ searchEngineId: e.id })}>
                    {e.name}
                  </button>
                ))}
              </div>
              {bookmarks.length > 0 && (
                <div className="bookmark-grid">
                  {bookmarks.slice(0, 24).map((b) => (
                    <div key={b.id} className="bookmark-tile" onClick={() => active && void window.api.browser.navigate(active.id, b.url)} title={b.url}>
                      <div className="t">{b.title}</div>
                      <div className="u">{hostOf(b.url)}</div>
                    </div>
                  ))}
                </div>
              )}
              <p className="muted small" style={{ maxWidth: 560, textAlign: 'center' }}>
                동영상 페이지를 열면 재생되는 동영상 소스를 자동으로 감지합니다. 우측 상단의 다운로드 아이콘에서 감지된 항목을 확인하세요.
              </p>
            </div>
          )}
        </div>

        {panel !== 'none' && (
          <aside className="side-panel">
            <header>
              <span className="grow">{PANEL_TITLE[panel]}</span>
              {panel === 'detected' && active && activeDetected.length > 0 && (
                <button className="btn sm ghost" onClick={() => void window.api.browser.clearDetected(active.id).then(() => setDetected((p) => ({ ...p, [active.id]: [] })))}>
                  비우기
                </button>
              )}
              {panel === 'history' && history.length > 0 && (
                <button
                  className="btn sm ghost"
                  onClick={() =>
                    void confirm('방문 기록을 모두 삭제할까요?', { danger: true }).then((ok) => ok && window.api.history.clear().then(() => loadHistory(historyQuery)))
                  }
                >
                  전체 삭제
                </button>
              )}
              <button className="icon-btn" onClick={() => setPanel('none')}>
                <Icon name="close" size={16} />
              </button>
            </header>
            {panel === 'history' && (
              <div style={{ padding: '8px 8px 0' }}>
                <input className="input" placeholder="기록 검색" value={historyQuery} onChange={(e) => setHistoryQuery(e.target.value)} />
              </div>
            )}
            <div className="list">
              {panel === 'adblock' && (
                <div className="adblock-panel">
                  <label className="switch-row">
                    <span>광고·추적 차단</span>
                    <input type="checkbox" checked={adblock?.enabled ?? false} onChange={(e) => void window.api.adblock.setEnabled(e.target.checked)} />
                  </label>
                  {tabStats?.host ? (
                    <div className="site-box">
                      <div className="host">{tabStats.host}</div>
                      <div className="muted small">
                        {!adblock?.enabled ? '차단이 전체적으로 꺼져 있습니다' : tabStats.allowed ? '이 사이트에서는 차단이 꺼져 있습니다' : `이 페이지에서 ${tabStats.blocked}개 차단`}
                      </div>
                      <button className={`btn sm ${tabStats.allowed ? 'primary' : ''}`} onClick={() => void toggleSite()} disabled={!adblock?.enabled}>
                        {tabStats.allowed ? '이 사이트에서 켜기' : '이 사이트에서 끄기'}
                      </button>
                    </div>
                  ) : (
                    <div className="muted small">페이지를 열면 사이트별로 차단을 켜고 끌 수 있습니다.</div>
                  )}
                  <div className="muted small">
                    총 차단 {adblock?.totalBlocked ?? 0}개 · 규칙 {(adblock?.ruleCount ?? 0).toLocaleString()}개
                    <br />
                    {adblock?.updating ? '필터 업데이트 중...' : adblock?.updatedAt ? `필터 업데이트 ${formatDate(adblock.updatedAt)}` : adblock?.ready ? '' : '필터 준비 중...'}
                  </div>
                  {adblock?.error && (
                    <div className="small" style={{ color: 'var(--warn)' }}>
                      {adblock.error}
                    </div>
                  )}
                  <label className="switch-row" style={{ marginTop: 4 }}>
                    <span>팝업 차단</span>
                    <input
                      type="checkbox"
                      checked={popupStats?.enabled ?? true}
                      onChange={(e) => void window.api.browser.setPopupBlockEnabled(e.target.checked).then(refreshPopupStats)}
                    />
                  </label>
                  {popupStats?.host && (
                    <div className="site-box">
                      <label className="checkbox small">
                        <input
                          type="checkbox"
                          checked={popupStats.allowed}
                          disabled={!popupStats.enabled}
                          onChange={(e) => void window.api.browser.setPopupAllowed(popupStats.host, e.target.checked).then(refreshPopupStats)}
                        />
                        {popupStats.host} 에서 팝업 허용
                      </label>
                      {popupStats.items.length > 0 ? (
                        <div className="popup-list">
                          <div className="muted small">차단된 팝업 {popupStats.items.length}개</div>
                          {popupStats.items.map((p) => (
                            <div key={`${p.url}-${p.at}`} className="popup-row" title={p.url}>
                              <span className="ellipsis">{hostOf(p.url)}</span>
                              <span className="muted small">{p.reason === 'no-gesture' ? '자동 실행' : p.reason === 'repeat' ? '중복' : p.reason === 'filter' ? '광고 목록' : '탭언더'}</span>
                              <button className="btn sm ghost" onClick={() => void window.api.browser.openBlockedPopup(popupStats.tabId, p.url).then(refreshPopupStats)}>
                                열기
                              </button>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div className="muted small">이 페이지에서 차단된 팝업이 없습니다.</div>
                      )}
                    </div>
                  )}
                  <button className="btn sm" onClick={() => setPage('settings')}>
                    <Icon name="settings" size={13} /> 필터 목록·사용자 규칙 관리
                  </button>
                </div>
              )}
              {panel === 'detected' &&
                (activeDetected.length === 0 ? (
                  <div className="empty">
                    아직 감지된 동영상이 없습니다.
                    <br />
                    <span className="small">페이지에서 동영상을 재생하면 여기에 표시됩니다.</span>
                  </div>
                ) : (
                  [...activeDetected].reverse().map((m) => {
                    const existing = taskByUrl.get(m.url)
                    const done = existing?.status === 'completed'
                    const inProgress = !!existing && !done && existing.status !== 'canceled' && existing.status !== 'error'
                    const busy = quickBusy.has(m.id)
                    return (
                      <div key={m.id} className={`media-item ${done ? 'downloaded' : ''}`}>
                        <div className="head">
                          <Thumb source={m.kind === 'dash' ? null : { kind: 'remote', url: m.url, headers: m.headers }} width={96} height={54} />
                          <div>
                            <div className="name">
                              <span className={`kind ${m.kind}`}>{m.kind === 'file' ? (m.mime.split('/')[1] ?? 'file') : m.kind}</span>
                              {m.filename || m.pageTitle || hostOf(m.url)}
                            </div>
                            <div className="meta">
                              {m.size ? `${formatBytes(m.size)} · ` : ''}
                              {hostOf(m.url)}
                            </div>
                            {done && (
                              <div className="dl-badge done" title={existing?.filePath}>
                                <Icon name="checkCircle" size={13} /> 다운로드됨
                              </div>
                            )}
                            {inProgress && (
                              <div className="dl-badge progress">
                                <Icon name="download" size={13} /> {existing?.status === 'paused' ? '일시정지됨' : '다운로드 중'}
                                {existing?.progress.percent != null ? ` ${existing.progress.percent.toFixed(0)}%` : ''}
                              </div>
                            )}
                          </div>
                        </div>
                        <div className="actions">
                          <button className="btn sm primary" onClick={() => requestAnalyze({ url: m.url, headers: m.headers, pageUrl: m.pageUrl, pageTitle: m.pageTitle, item: m })}>
                            <Icon name="download" size={13} /> {done ? '다시 받기' : '다운로드'}
                          </button>
                          <button className="btn sm quick" disabled={busy || inProgress} onClick={() => void quickDownload(m)} title="분석 창 없이 기본 화질 설정으로 바로 다운로드">
                            <Icon name="bolt" size={13} /> {busy ? '준비 중' : '바로 받기'}
                          </button>
                          {m.kind !== 'dash' && (
                            <button className="btn sm" onClick={() => void playDetected(m)}>
                              <Icon name="play" size={13} /> 재생
                            </button>
                          )}
                          <button className="btn sm ghost" onClick={() => void navigator.clipboard.writeText(m.url).then(() => toast({ type: 'info', message: '주소를 복사했습니다' }))} title="주소 복사">
                            <Icon name="copy" size={13} />
                          </button>
                        </div>
                      </div>
                    )
                  })
                ))}
              {panel === 'bookmarks' &&
                (bookmarks.length === 0 ? (
                  <div className="empty">즐겨찾기가 없습니다. 주소창 옆 별 아이콘으로 추가하세요.</div>
                ) : (
                  bookmarks.map((b) => (
                    <div key={b.id} className="list-item" onClick={() => active && void window.api.browser.navigate(active.id, b.url)}>
                      <Icon name="star" size={14} className="muted" />
                      <div className="title">
                        <div>{b.title}</div>
                        <div>{b.url}</div>
                      </div>
                      <button
                        className="icon-btn"
                        onClick={(e) => {
                          e.stopPropagation()
                          void window.api.bookmarks.remove(b.id).then(loadBookmarks)
                        }}
                        title="삭제"
                      >
                        <Icon name="trash" size={14} />
                      </button>
                    </div>
                  ))
                ))}
              {panel === 'history' &&
                (history.length === 0 ? (
                  <div className="empty">방문 기록이 없습니다.</div>
                ) : (
                  history.map((h) => (
                    <div key={h.id} className="list-item" onClick={() => active && void window.api.browser.navigate(active.id, h.url)}>
                      <div className="title">
                        <div>{h.title}</div>
                        <div>
                          {formatDate(h.visitedAt)} · {h.url}
                        </div>
                      </div>
                      <button
                        className="icon-btn"
                        onClick={(e) => {
                          e.stopPropagation()
                          void window.api.history.remove(h.id).then(() => loadHistory(historyQuery))
                        }}
                        title="삭제"
                      >
                        <Icon name="close" size={14} />
                      </button>
                    </div>
                  ))
                ))}
            </div>
          </aside>
        )}
      </div>
      {confirmDialog}
    </div>
  )
}
