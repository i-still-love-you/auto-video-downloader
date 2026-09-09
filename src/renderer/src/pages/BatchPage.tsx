import React, { useCallback, useEffect, useMemo, useState } from 'react'
import type { BatchItem, BatchItemStatus, BatchJob, BatchOptions, BatchPreview, BatchStatus, PreferredQuality } from '@shared/types'
import { useApp } from '../state/AppContext'
import { useBatch } from '../hooks/useBatch'
import { Icon } from '../components/Icon'
import { useConfirm } from '../components/Modal'
import { Thumb } from '../components/Thumb'
import { errorText, formatDate, hostOf } from '../lib/format'

type FormOptions = Omit<BatchOptions, 'tabId'>

const DEFAULT_OPTIONS: FormOptions = {
  startPage: 1,
  maxPages: 0,
  maxItems: 0,
  quality: 'settings',
  skipDownloaded: true,
  skipLikely: true,
  pageDelayMs: 1500,
  filter: ''
}

const QUALITY: Array<{ v: FormOptions['quality']; label: string }> = [
  { v: 'settings', label: '설정의 기본 화질' },
  { v: 'best', label: '최고 화질' },
  { v: '1080', label: '1080p 이하' },
  { v: '720', label: '720p 이하' },
  { v: '480', label: '480p 이하' },
  { v: 'worst', label: '최저 화질' }
]

/** 펼친 작업에서 한 번에 그리는 항목 수. 수천 개를 한꺼번에 그리지 않도록 "더 보기"로 늘린다 */
const ITEM_PAGE = 200

const JOB_LABEL: Record<BatchStatus, string> = {
  running: '실행 중',
  paused: '일시정지',
  completed: '완료',
  stopped: '중지됨',
  error: '오류'
}

const ITEM_LABEL: Record<BatchItemStatus, string> = {
  found: '대기',
  resolving: '주소 확인 중',
  queued: '큐에 추가됨',
  downloading: '다운로드 중',
  paused: '일시정지됨',
  completed: '완료',
  error: '실패',
  skipped: '건너뜀'
}

function loadOptions(): FormOptions {
  try {
    const raw = localStorage.getItem('batch.options')
    if (!raw) return DEFAULT_OPTIONS
    const o = JSON.parse(raw) as Partial<FormOptions>
    return { ...DEFAULT_OPTIONS, ...o, filter: '' }
  } catch {
    return DEFAULT_OPTIONS
  }
}

function saveOptions(o: FormOptions): void {
  try {
    localStorage.setItem('batch.options', JSON.stringify(o))
  } catch {
    /* ignore */
  }
}

interface Counts {
  total: number
  found: number
  resolving: number
  queued: number
  downloading: number
  paused: number
  completed: number
  error: number
  skipped: number
}

function countOf(job: BatchJob): Counts {
  const c: Counts = { total: job.items.length, found: 0, resolving: 0, queued: 0, downloading: 0, paused: 0, completed: 0, error: 0, skipped: 0 }
  for (const it of job.items) c[it.status]++
  return c
}

export function BatchPage({ active }: { active: boolean }): React.JSX.Element {
  const { toast, setPage, batchPrefill, clearBatchPrefill } = useApp()
  const jobs = useBatch()
  const [url, setUrl] = useState('')
  const [opts, setOpts] = useState<FormOptions>(loadOptions)
  const [preview, setPreview] = useState<BatchPreview | null>(null)
  const [previewUrl, setPreviewUrl] = useState('')
  const [previewing, setPreviewing] = useState(false)
  const [starting, setStarting] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [itemFilter, setItemFilter] = useState<'all' | 'active' | 'error' | 'done'>('all')
  const [confirm, confirmDialog] = useConfirm()

  useEffect(() => {
    if (batchPrefill) {
      setUrl(batchPrefill)
      setPreview(null)
      clearBatchPrefill()
    }
  }, [batchPrefill, clearBatchPrefill])

  useEffect(() => saveOptions(opts), [opts])

  const setOpt = <K extends keyof FormOptions>(key: K, value: FormOptions[K]): void => setOpts((o) => ({ ...o, [key]: value }))

  /** 주소와 같은 사이트를 보고 있는 탭이 있으면 그 탭의 세션(쿠키·로그인)을 빌린다 */
  const tabIdFor = async (target: string): Promise<number | undefined> => {
    try {
      const s = await window.api.browser.getState()
      const host = hostOf(target)
      const activeTab = s.tabs.find((t) => t.id === s.activeTabId)
      if (activeTab?.url && hostOf(activeTab.url) === host) return activeTab.id
      return s.tabs.find((t) => t.url && hostOf(t.url) === host)?.id
    } catch {
      return undefined
    }
  }

  const useCurrentTab = async (): Promise<void> => {
    const s = await window.api.browser.getState()
    const t = s.tabs.find((x) => x.id === s.activeTabId)
    if (t?.url) {
      setUrl(t.url)
      setPreview(null)
    } else toast({ type: 'info', message: '브라우저에서 열린 페이지가 없습니다' })
  }

  const runPreview = async (): Promise<void> => {
    const target = url.trim()
    if (!/^https?:\/\//i.test(target)) {
      toast({ type: 'error', message: 'http(s) 주소를 입력해 주세요' })
      return
    }
    setPreviewing(true)
    setPreview(null)
    try {
      const tabId = await tabIdFor(target)
      const p = await window.api.batch.preview(target, tabId, opts.filter)
      setPreview(p)
      setPreviewUrl(target)
      if (p.challenge) toast({ type: 'error', message: '사이트의 보안 확인 페이지에 막혔습니다. 브라우저 탭에서 사이트를 먼저 열어 주세요.' })
      else if (!p.items.length) toast({ type: 'info', message: '이 페이지에서 영상 링크를 찾지 못했습니다' })
    } catch (e) {
      toast({ type: 'error', message: errorText(e) })
    } finally {
      setPreviewing(false)
    }
  }

  const start = async (): Promise<void> => {
    const target = url.trim()
    if (!/^https?:\/\//i.test(target)) {
      toast({ type: 'error', message: 'http(s) 주소를 입력해 주세요' })
      return
    }
    setStarting(true)
    try {
      const tabId = await tabIdFor(target)
      const job = await window.api.batch.create(target, { ...opts, tabId })
      toast({ type: 'success', message: `자동 다운로드를 시작했습니다: ${job.host}` })
      setPreview(null)
      setExpanded(job.id)
    } catch (e) {
      toast({ type: 'error', message: errorText(e) })
    } finally {
      setStarting(false)
    }
  }

  // 아래 함수들은 memo 된 JobCard/ItemRow 에 넘어가므로 참조가 유지되어야 바뀐 행만 다시 그린다
  const act = useCallback(
    async (fn: () => Promise<unknown>): Promise<void> => {
      try {
        await fn()
      } catch (e) {
        toast({ type: 'error', message: errorText(e) })
      }
    },
    [toast]
  )

  const removeJob = useCallback(
    async (job: BatchJob): Promise<void> => {
      const c = countOf(job)
      const activeCount = c.queued + c.downloading + c.paused
      if (activeCount > 0) {
        const ok = await confirm(`진행 중인 다운로드 ${activeCount}개를 취소하고 작업을 제거할까요?\n(취소하지 않으려면 먼저 일시정지하세요)`, { danger: true })
        if (!ok) return
        await act(() => window.api.batch.remove(job.id, true))
        return
      }
      await act(() => window.api.batch.remove(job.id, false))
    },
    [confirm, act]
  )

  const openInBrowser = useCallback(
    (u: string): void => {
      void window.api.browser.newTab(u).then(() => setPage('browser'))
    },
    [setPage]
  )

  const toggleExpanded = useCallback((id: string) => setExpanded((cur) => (cur === id ? null : id)), [])

  const runningCount = jobs.filter((j) => j.status === 'running').length

  return (
    <>
      <div className="page-header">
        <h2>자동 다운로드</h2>
        <span className="muted small">목록 페이지(검색 결과·카테고리) 주소 하나로 페이지를 넘겨 가며 영상을 모두 받습니다</span>
        {runningCount > 0 && <span className="status running" style={{ marginLeft: 'auto' }}>{runningCount}개 실행 중</span>}
      </div>
      <div className="page-body">
        <section className="batch-form">
          <div className="row">
            <input
              className="input"
              value={url}
              onChange={(e) => {
                setUrl(e.target.value)
                if (preview && e.target.value.trim() !== previewUrl) setPreview(null)
              }}
              placeholder="목록 페이지 주소 (예: https://example.com/search/keyword/)"
              spellCheck={false}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void runPreview()
              }}
            />
            <button className="btn" type="button" onClick={() => void useCurrentTab()} title="브라우저에서 보고 있는 페이지 주소 가져오기">
              <Icon name="globe" size={14} /> 현재 탭
            </button>
          </div>
          <div className="batch-grid">
            <label className="field">
              <span className="field-label">시작 페이지</span>
              <input className="input" type="number" min={1} value={opts.startPage} onChange={(e) => setOpt('startPage', Math.max(1, Number(e.target.value) || 1))} />
            </label>
            <label className="field">
              <span className="field-label">최대 페이지 수 (0 = 끝까지)</span>
              <input className="input" type="number" min={0} value={opts.maxPages} onChange={(e) => setOpt('maxPages', Math.max(0, Number(e.target.value) || 0))} />
            </label>
            <label className="field">
              <span className="field-label">최대 영상 수 (0 = 제한 없음)</span>
              <input className="input" type="number" min={0} value={opts.maxItems} onChange={(e) => setOpt('maxItems', Math.max(0, Number(e.target.value) || 0))} />
            </label>
            <label className="field">
              <span className="field-label">화질</span>
              <select className="select" value={opts.quality} onChange={(e) => setOpt('quality', e.target.value as PreferredQuality | 'settings')} style={{ width: '100%' }}>
                {QUALITY.map((q) => (
                  <option key={q.v} value={q.v}>
                    {q.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span className="field-label">페이지 간 대기 (초)</span>
              <input className="input" type="number" min={0} step={0.5} value={opts.pageDelayMs / 1000} onChange={(e) => setOpt('pageDelayMs', Math.max(0, Number(e.target.value) || 0) * 1000)} />
            </label>
            <label className="field wide">
              <span className="field-label">제목·주소 필터 (문자열 또는 정규식, 비우면 전체)</span>
              <input className="input" value={opts.filter} onChange={(e) => setOpt('filter', e.target.value)} placeholder="예: 4k|1080" spellCheck={false} />
            </label>
          </div>
          <div className="row wrap" style={{ gap: 14 }}>
            <label className="checkbox" title="다운로드 이력에 같은 영상 페이지나 같은 소스 주소가 있으면 건너뜁니다 (파일을 옮겼어도 이력 기준)">
              <input type="checkbox" checked={opts.skipDownloaded} onChange={(e) => setOpt('skipDownloaded', e.target.checked)} />
              이미 받은 영상은 건너뛰기
            </label>
            <label className="checkbox" title="크기·길이·제목이 같아 같은 영상으로 보이는 것도 건너뜁니다 (드물게 다른 영상을 건너뛸 수 있음)">
              <input type="checkbox" checked={opts.skipLikely} disabled={!opts.skipDownloaded} onChange={(e) => setOpt('skipLikely', e.target.checked)} />
              유력한 중복(크기·제목 일치)도 건너뛰기
            </label>
            <span className="grow" />
            <button className="btn" onClick={() => void runPreview()} disabled={previewing || !url.trim()} title="첫 페이지만 읽어 어떤 영상이 잡히는지 확인">
              <Icon name="eye" size={14} /> {previewing ? '확인 중...' : '미리 보기'}
            </button>
            <button className="btn primary" onClick={() => void start()} disabled={starting || !url.trim()}>
              <Icon name="bolt" size={14} /> 자동 다운로드 시작
            </button>
          </div>
          {previewing && (
            <div className="progress indeterminate" style={{ marginTop: 4 }}>
              <div />
            </div>
          )}
          {preview && (
            <div className="batch-preview">
              <div className="row">
                <strong className="grow ellipsis" title={preview.title}>
                  {preview.title || preview.url}
                </strong>
                <span className="muted small">
                  첫 페이지에서 {preview.items.length}개 발견 · 다음 페이지 {preview.next ? '있음' : '없음'}
                </span>
              </div>
              {preview.items.length > 0 && (
                <div className="preview-grid">
                  {preview.items.slice(0, 40).map((it) => (
                    <div key={it.url} className="preview-item" title={it.url} onClick={() => openInBrowser(it.url)}>
                      <Thumb source={it.thumb ? { kind: 'url', url: it.thumb } : null} width="100%" height={72} />
                      <div className="t">{it.title}</div>
                      {it.duration && <div className="d">{it.duration}</div>}
                    </div>
                  ))}
                </div>
              )}
              {preview.items.length > 40 && <div className="muted small">외 {preview.items.length - 40}개</div>}
            </div>
          )}
          <p className="muted small" style={{ margin: '6px 0 0' }}>
            목록에서 영상 페이지 링크를 찾아 한 페이지씩 읽고, 각 영상 페이지에서 실제 동영상 주소를 찾아 다운로드 큐에 넣습니다. 큐에는 동시 다운로드 수보다 조금 많은 정도만 미리 넣으며, 일시정지하면 새 항목을 더 찾지 않습니다(이미 추가된 다운로드는 계속됩니다).
          </p>
        </section>

        {jobs.length === 0 ? (
          <div className="empty">
            아직 자동 다운로드 작업이 없습니다.
            <br />
            <span className="small">브라우저에서 검색 결과나 카테고리 페이지를 연 뒤, 감지 목록 옆의 자동 다운로드 버튼이나 우클릭 메뉴로 시작할 수도 있습니다.</span>
          </div>
        ) : (
          jobs.map((job) => (
            <JobCard
              key={job.id}
              job={job}
              expanded={expanded === job.id}
              onToggle={toggleExpanded}
              itemFilter={itemFilter}
              setItemFilter={setItemFilter}
              onRemove={removeJob}
              onOpen={openInBrowser}
              act={act}
              visible={active}
            />
          ))
        )}
      </div>
      {confirmDialog}
    </>
  )
}

/** 작업 카드. memo 로 감싸 다른 작업의 갱신에는 다시 그리지 않는다 */
const JobCard = React.memo(function JobCard({
  job,
  expanded,
  onToggle,
  itemFilter,
  setItemFilter,
  onRemove,
  onOpen,
  act,
  visible
}: {
  job: BatchJob
  expanded: boolean
  onToggle: (id: string) => void
  itemFilter: 'all' | 'active' | 'error' | 'done'
  setItemFilter: (f: 'all' | 'active' | 'error' | 'done') => void
  onRemove: (job: BatchJob) => void
  onOpen: (url: string) => void
  act: (fn: () => Promise<unknown>) => Promise<void>
  visible: boolean
}): React.JSX.Element {
  const c = useMemo(() => countOf(job), [job])
  const [limit, setLimit] = useState(ITEM_PAGE)
  useEffect(() => setLimit(ITEM_PAGE), [itemFilter, expanded])
  const finished = c.completed + c.error + c.skipped
  const pct = c.total > 0 ? (finished / c.total) * 100 : 0
  const crawling = job.status === 'running' && !job.pages.done
  const barClass = job.status === 'completed' ? (c.error ? 'paused' : 'done') : job.status === 'error' ? 'error' : job.status === 'paused' || job.status === 'stopped' ? 'paused' : ''
  const items = useMemo(() => {
    if (itemFilter === 'active') return job.items.filter((i) => i.status === 'found' || i.status === 'resolving' || i.status === 'queued' || i.status === 'downloading' || i.status === 'paused')
    if (itemFilter === 'error') return job.items.filter((i) => i.status === 'error')
    if (itemFilter === 'done') return job.items.filter((i) => i.status === 'completed' || i.status === 'skipped')
    return job.items
  }, [job.items, itemFilter])
  const canResume = job.status === 'paused' || job.status === 'stopped' || job.status === 'error' || (job.status === 'completed' && (c.found > 0 || c.paused > 0 || !job.pages.done))
  /** 목록 페이지 읽기에 실패해 다음 확인(5분 간격)을 기다리는 중 */
  const waitingRetry = job.status === 'running' && !!job.pages.retryAt
  /** 목록 페이지 읽기 실패로 끝난 작업: 남은 주소가 있으므로 강제로 이어서 읽을 수 있다 */
  const endedByCrawlFailure = job.status !== 'running' && job.pages.done && !!job.pages.nextUrl && !!job.error
  const retryTime = job.pages.retryAt ? new Date(job.pages.retryAt).toTimeString().slice(0, 5) : ''

  return (
    <div className={`batch-job ${job.status}`}>
      <div className="head">
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="title ellipsis" title={job.sourceUrl}>
            <span className={`status ${job.status}`}>{JOB_LABEL[job.status]}</span>
            {job.title || job.host}
          </div>
          <div className="sub ellipsis">
            {job.host} · {job.sourceUrl}
          </div>
        </div>
        <div className="actions">
          {job.status === 'running' ? (
            <button className="icon-btn" title="일시정지 (새 항목 추가 중단)" onClick={() => void act(() => window.api.batch.pause(job.id))}>
              <Icon name="pause" />
            </button>
          ) : canResume ? (
            <button className="icon-btn" title={c.paused > 0 ? `이어서 (일시정지된 다운로드 ${c.paused}개도 다시 시작)` : '이어서'} onClick={() => void act(() => window.api.batch.resume(job.id))}>
              <Icon name="play" />
            </button>
          ) : null}
          {(waitingRetry || endedByCrawlFailure) && (
            <button
              className="btn sm"
              title={waitingRetry ? `${retryTime} 확인 예정을 기다리지 않고 지금 목록 페이지를 다시 읽습니다` : '실패했던 목록 페이지부터 강제로 이어서 읽습니다'}
              onClick={() => void act(() => window.api.batch.continueNow(job.id))}
            >
              {waitingRetry ? '지금 다시 확인' : '강제로 이어서'}
            </button>
          )}
          {(job.status === 'running' || c.queued + c.downloading + c.paused > 0) && (
            <button className="icon-btn" title="중지 (이 작업의 진행 중 다운로드도 취소)" onClick={() => void act(() => window.api.batch.stop(job.id))}>
              <Icon name="stop" />
            </button>
          )}
          {c.error > 0 && (
            <button className="icon-btn" title={`실패한 ${c.error}개 다시 시도`} onClick={() => void act(() => window.api.batch.retryFailed(job.id))}>
              <Icon name="reload" />
            </button>
          )}
          <button className="icon-btn" title="목록 페이지 열기" onClick={() => onOpen(job.sourceUrl)}>
            <Icon name="open" />
          </button>
          <button className="icon-btn" title="작업 제거 (받은 파일은 남음)" onClick={() => void onRemove(job)}>
            <Icon name="close" />
          </button>
          <button className={`icon-btn ${expanded ? 'active' : ''}`} title={expanded ? '접기' : '항목 보기'} onClick={() => onToggle(job.id)}>
            <Icon name="list" />
          </button>
        </div>
      </div>
      <div className={`progress ${barClass} ${crawling && c.total === 0 ? 'indeterminate' : ''}`}>
        <div style={{ width: `${pct}%` }} />
      </div>
      <div className="stats">
        <span>
          페이지 {job.pages.scanned}
          {job.pages.done ? '' : job.status === 'running' ? (waitingRetry ? ` (읽기 실패 · ${retryTime}에 다시 확인)` : ' (계속 확인 중)') : ' (남은 페이지 있음)'}
        </span>
        <span>발견 {c.total}</span>
        <span className="ok">완료 {c.completed}</span>
        {c.downloading + c.queued + c.resolving > 0 && <span className="busy">진행 {c.downloading + c.queued + c.resolving}</span>}
        {c.paused > 0 && <span className="warn">일시정지 {c.paused}</span>}
        {c.found > 0 && <span>대기 {c.found}</span>}
        {c.error > 0 && <span className="bad">실패 {c.error}</span>}
        {c.skipped > 0 && <span>건너뜀 {c.skipped}</span>}
        <span className="muted">{formatDate(job.createdAt)}</span>
        <span className="muted">
          {job.options.quality === 'settings' ? '설정 화질' : QUALITY.find((q) => q.v === job.options.quality)?.label}
          {job.options.maxPages ? ` · 최대 ${job.options.maxPages}페이지` : ''}
          {job.options.maxItems ? ` · 최대 ${job.options.maxItems}개` : ''}
          {job.options.filter ? ` · 필터 "${job.options.filter}"` : ''}
        </span>
      </div>
      {job.error && <div className="error">{job.error}</div>}
      {expanded && (
        <div className="batch-items">
          <div className="row" style={{ padding: '6px 0' }}>
            <div className="seg">
              {(['all', 'active', 'error', 'done'] as const).map((f) => (
                <button key={f} className={itemFilter === f ? 'active' : ''} onClick={() => setItemFilter(f)}>
                  {f === 'all' ? `전체 ${c.total}` : f === 'active' ? `진행 ${c.found + c.resolving + c.queued + c.downloading + c.paused}` : f === 'error' ? `실패 ${c.error}` : `완료 ${c.completed + c.skipped}`}
                </button>
              ))}
            </div>
          </div>
          {items.length === 0 ? (
            <div className="empty" style={{ padding: 24 }}>
              {c.total === 0 ? (crawling ? '목록 페이지를 읽는 중입니다...' : '발견한 영상이 없습니다') : '해당 조건의 항목이 없습니다'}
            </div>
          ) : (
            <>
              {items.slice(0, limit).map((it) => (
                <ItemRow key={it.id} jobId={job.id} item={it} onOpen={onOpen} act={act} visible={visible} />
              ))}
              {items.length > limit && (
                <button className="btn" style={{ display: 'block', margin: '8px auto' }} onClick={() => setLimit((l) => l + ITEM_PAGE)}>
                  더 보기 (남은 {items.length - limit}개)
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
})

/** 항목 한 줄. memo 로 감싸 상태가 바뀐 항목만 다시 그린다 (useBatch 가 바뀌지 않은 항목의 참조를 유지해 준다) */
const ItemRow = React.memo(function ItemRow({ jobId, item: it, onOpen, act, visible }: { jobId: string; item: BatchItem; onOpen: (url: string) => void; act: (fn: () => Promise<unknown>) => Promise<void>; visible: boolean }): React.JSX.Element {
  return (
    <div className={`batch-item ${it.status}`}>
      <Thumb source={visible && it.thumb ? { kind: 'url', url: it.thumb } : null} width={80} height={45} />
      <div className="body">
        <div className="t ellipsis" title={it.url}>
          {it.title}
        </div>
        <div className="m">
          <span className={`status ${it.status}`}>{ITEM_LABEL[it.status]}</span>
          {it.duration && <span>{it.duration}</span>}
          <span>{it.page}페이지</span>
          {it.extractor && <span className="muted">{it.extractor === 'kvs' ? '플레이어 설정' : it.extractor === 'generic' ? '페이지 태그' : 'yt-dlp'}</span>}
          {it.error && (
            <span className={it.status === 'error' ? 'bad' : 'muted'} title={it.error}>
              {it.error}
            </span>
          )}
        </div>
      </div>
      <div className="actions">
        {it.status === 'paused' && (
          <button className="icon-btn" title="이 다운로드 다시 시작" onClick={() => void act(() => window.api.batch.resumeItem(jobId, it.id))}>
            <Icon name="play" size={16} />
          </button>
        )}
        {(it.status === 'error' || it.status === 'skipped') && (
          <button className="icon-btn" title="다시 시도" onClick={() => void act(() => window.api.batch.retryItem(jobId, it.id))}>
            <Icon name="reload" size={16} />
          </button>
        )}
        {it.status !== 'completed' && it.status !== 'skipped' && (
          <button className="icon-btn" title={it.status === 'queued' || it.status === 'downloading' || it.status === 'paused' ? '다운로드 취소하고 건너뛰기' : '건너뛰기'} onClick={() => void act(() => window.api.batch.skipItem(jobId, it.id))}>
            <Icon name="close" size={16} />
          </button>
        )}
        <button className="icon-btn" title="영상 페이지 열기" onClick={() => onOpen(it.url)}>
          <Icon name="open" size={16} />
        </button>
      </div>
    </div>
  )
})
