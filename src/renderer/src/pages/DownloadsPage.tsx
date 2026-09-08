import React, { useCallback, useEffect, useMemo, useState } from 'react'
import type { DownloadTask } from '@shared/types'
import type { DownloadRecord } from '@shared/dedupe'
import { useApp } from '../state/AppContext'
import { useDownloads } from '../hooks/useDownloads'
import { useLibrary } from '../hooks/useLibrary'
import { Icon } from '../components/Icon'
import { Modal, useConfirm } from '../components/Modal'
import { Thumb, type ThumbSource } from '../components/Thumb'
import { errorText, fileNameOf, formatBytes, formatDate, formatDuration, formatEta, formatSpeed, hostOf } from '../lib/format'

type Filter = 'all' | 'active' | 'done'

/** 한 번에 그리는 행 수. 수천 개를 한꺼번에 그리면 갱신마다 느려지므로 "더 보기"로 늘린다 */
const TASK_PAGE = 100

const STATUS_LABEL: Record<DownloadTask['status'], string> = {
  queued: '대기 중',
  running: '다운로드 중',
  paused: '일시정지',
  completed: '완료',
  error: '오류',
  canceled: '취소됨'
}

export function DownloadsPage(): React.JSX.Element {
  const { requestAnalyze, play, toast } = useApp()
  const tasks = useDownloads()
  const [url, setUrl] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [logTask, setLogTask] = useState<DownloadTask | null>(null)
  const [log, setLog] = useState<string[]>([])
  const [historyOpen, setHistoryOpen] = useState(false)
  const [confirm, confirmDialog] = useConfirm()
  const library = useLibrary()

  const visible = useMemo(() => {
    if (filter === 'active') return tasks.filter((t) => t.status === 'running' || t.status === 'queued' || t.status === 'paused')
    if (filter === 'done') return tasks.filter((t) => t.status === 'completed')
    return tasks
  }, [tasks, filter])
  const [limit, setLimit] = useState(TASK_PAGE)
  useEffect(() => setLimit(TASK_PAGE), [filter])

  const submit = (e: React.FormEvent): void => {
    e.preventDefault()
    const v = url.trim()
    if (!v) return
    requestAnalyze({ url: v })
    setUrl('')
  }

  const paste = async (): Promise<void> => {
    try {
      const text = (await navigator.clipboard.readText()).trim()
      if (/^https?:\/\//i.test(text)) requestAnalyze({ url: text })
      else toast({ type: 'info', message: '클립보드에 http(s) 주소가 없습니다' })
    } catch {
      toast({ type: 'error', message: '클립보드를 읽을 수 없습니다' })
    }
  }

  // 행 컴포넌트는 memo 되어 있으므로 여기서 넘기는 함수의 참조가 유지되어야 바뀐 행만 다시 그린다
  const playTask = useCallback(
    (t: DownloadTask): void => {
      if (!t.filePath) return
      const src = `media://local/?p=${encodeURIComponent(t.filePath)}`
      play({ id: `file:${t.filePath}`, title: fileNameOf(t.filePath), src, kind: 'local', path: t.filePath })
    },
    [play]
  )

  const removeTask = useCallback(
    async (t: DownloadTask): Promise<void> => {
      if (t.status === 'completed' && t.filePath) {
        const ok = await confirm(`목록에서 제거할까요?\n파일은 남겨 둡니다: ${fileNameOf(t.filePath)}`)
        if (ok) await window.api.downloads.remove(t.id, false)
        return
      }
      const ok = t.status === 'running' || t.status === 'paused' ? await confirm('진행 중인 다운로드를 취소하고 목록에서 제거할까요?', { danger: true }) : true
      if (ok) await window.api.downloads.remove(t.id, true)
    },
    [confirm]
  )

  const deleteWithFile = useCallback(
    async (t: DownloadTask): Promise<void> => {
      const ok = await confirm(`파일까지 삭제할까요?\n${t.filePath ?? ''}`, { danger: true, title: '파일 삭제' })
      if (ok) await window.api.downloads.remove(t.id, true)
    },
    [confirm]
  )

  const showLog = useCallback(async (t: DownloadTask): Promise<void> => {
    setLog(await window.api.downloads.getLog(t.id))
    setLogTask(t)
  }, [])

  return (
    <>
      <div className="dl-toolbar">
        <form onSubmit={submit}>
          <input className="input" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="동영상 페이지 주소, m3u8 또는 mp4 주소를 붙여넣기" spellCheck={false} />
          <button className="btn primary" type="submit" disabled={!url.trim()}>
            <Icon name="search" size={14} /> 분석
          </button>
          <button className="btn" type="button" onClick={() => void paste()} title="클립보드 주소로 바로 분석">
            <Icon name="copy" size={14} /> 붙여넣기
          </button>
        </form>
        <div className="seg">
          {(['all', 'active', 'done'] as Filter[]).map((f) => (
            <button key={f} className={filter === f ? 'active' : ''} onClick={() => setFilter(f)}>
              {f === 'all' ? '전체' : f === 'active' ? '진행 중' : '완료'}
            </button>
          ))}
        </div>
        <button className="btn" onClick={() => void window.api.downloads.clearFinished()} title="완료/취소된 항목을 목록에서 제거 (다운로드 이력은 남음)">
          목록 정리
        </button>
        <button className="btn" onClick={() => setHistoryOpen(true)} title="받은 영상 이력. 파일을 옮겨도 남아 있어 같은 영상을 다시 받지 않게 합니다">
          <Icon name="history" size={14} /> 이력{library.length ? ` ${library.length}` : ''}
        </button>
      </div>
      <div className="page-body">
        {visible.length === 0 ? (
          <div className="empty">
            {tasks.length === 0 ? (
              <>
                다운로드 항목이 없습니다.
                <br />
                <span className="small">위에 주소를 붙여넣거나 브라우저에서 감지된 동영상을 다운로드하세요.</span>
              </>
            ) : (
              '해당 조건의 항목이 없습니다.'
            )}
          </div>
        ) : (
          <>
            {visible.slice(0, limit).map((t) => (
              <TaskRow key={t.id} task={t} onPlay={playTask} onRemove={removeTask} onDeleteFile={deleteWithFile} onLog={showLog} />
            ))}
            {visible.length > limit && (
              <button className="btn" style={{ display: 'block', margin: '10px auto' }} onClick={() => setLimit((l) => l + TASK_PAGE)}>
                더 보기 (남은 {visible.length - limit}개)
              </button>
            )}
          </>
        )}
      </div>
      {logTask && (
        <Modal title={`로그: ${logTask.title}`} onClose={() => setLogTask(null)} width={760}>
          <div className="log-box">{log.length ? log.join('\n') : '기록된 로그가 없습니다.'}</div>
        </Modal>
      )}
      {historyOpen && <HistoryDialog records={library} onClose={() => setHistoryOpen(false)} confirm={confirm} />}
      {confirmDialog}
    </>
  )
}

/** 다운로드 이력 창: 받은 영상의 페이지·크기·길이와 파일 유무를 보여 주고 삭제할 수 있다 */
function HistoryDialog({
  records,
  onClose,
  confirm
}: {
  records: DownloadRecord[]
  onClose: () => void
  confirm: (message: string, opts?: { title?: string; danger?: boolean }) => Promise<boolean>
}): React.JSX.Element {
  const { setPage, toast } = useApp()
  const [query, setQuery] = useState('')
  const list = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return records
    return records.filter((r) => r.title.toLowerCase().includes(q) || r.host.includes(q) || (r.pageUrl ?? '').toLowerCase().includes(q) || r.filePath.toLowerCase().includes(q))
  }, [records, query])
  const missing = records.filter((r) => r.exists === false).length
  const openPage = (url: string): void => {
    void window.api.browser.newTab(url).then(() => {
      onClose()
      setPage('browser')
    })
  }
  const clearAll = async (): Promise<void> => {
    const ok = await confirm(`다운로드 이력 ${records.length}개를 모두 지울까요?\n지우면 같은 영상을 다시 받을 때 중복으로 알려 주지 못합니다. 파일은 지우지 않습니다.`, { danger: true, title: '이력 삭제' })
    if (ok) {
      await window.api.library.clear()
      toast({ type: 'info', message: '다운로드 이력을 모두 지웠습니다' })
    }
  }
  return (
    <Modal
      title="다운로드 이력"
      onClose={onClose}
      width={820}
      footer={
        <>
          <span className="muted small" style={{ marginRight: 'auto' }}>
            총 {records.length}개{missing ? ` · 파일이 제자리에 없는 항목 ${missing}개` : ''}. 파일을 옮기거나 지워도 이력은 남아 같은 영상을 다시 받지 않도록 알려 줍니다.
          </span>
          <button className="btn" disabled={!records.length} onClick={() => void clearAll()}>
            <Icon name="trash" size={14} /> 전체 삭제
          </button>
          <button className="btn primary" onClick={onClose}>
            닫기
          </button>
        </>
      }
    >
      <input className="input" placeholder="제목·사이트·주소·파일 이름 검색" value={query} onChange={(e) => setQuery(e.target.value)} autoFocus />
      <div className="history-list">
        {list.length === 0 ? (
          <div className="empty" style={{ padding: 30 }}>
            {records.length === 0 ? '아직 이력이 없습니다. 다운로드가 완료되면 여기에 기록됩니다.' : '검색 결과가 없습니다.'}
          </div>
        ) : (
          list.slice(0, 500).map((r) => (
            <div key={r.id} className="history-row">
              <Thumb source={r.thumbnail ? { kind: 'url', url: r.thumbnail } : r.exists ? { kind: 'local', path: r.filePath } : null} width={72} height={40} />
              <div className="body">
                <div className="t ellipsis" title={r.filePath}>
                  {r.title}
                </div>
                <div className="m">
                  <span>{r.host}</span>
                  <span>{formatDate(r.downloadedAt)}</span>
                  {r.size ? <span>{formatBytes(r.size)}</span> : null}
                  {r.duration ? <span>{formatDuration(r.duration)}</span> : null}
                  {r.resolution && <span>{r.resolution}</span>}
                  <span className={`pill ${r.exists ? 'ok' : 'no'}`}>{r.exists ? '파일 있음' : '파일 없음'}</span>
                </div>
              </div>
              <div className="actions">
                {r.exists && (
                  <button className="icon-btn" title="폴더에서 보기" onClick={() => void window.api.files.showInFolder(r.filePath)}>
                    <Icon name="folder" size={16} />
                  </button>
                )}
                {r.pageUrl && (
                  <button className="icon-btn" title="영상 페이지 열기" onClick={() => openPage(r.pageUrl!)}>
                    <Icon name="open" size={16} />
                  </button>
                )}
                <button className="icon-btn" title="이력에서 삭제 (파일은 남김)" onClick={() => void window.api.library.remove(r.id)}>
                  <Icon name="close" size={16} />
                </button>
              </div>
            </div>
          ))
        )}
        {list.length > 500 && <div className="muted small">외 {list.length - 500}개는 검색으로 좁혀 주세요.</div>}
      </div>
    </Modal>
  )
}

/** 다운로드 한 줄. memo 로 감싸 갱신된 항목의 행만 다시 그린다 (진행률은 250ms 마다 오므로 중요) */
const TaskRow = React.memo(function TaskRow({
  task: t,
  onPlay,
  onRemove,
  onDeleteFile,
  onLog
}: {
  task: DownloadTask
  onPlay: (t: DownloadTask) => void
  onRemove: (t: DownloadTask) => Promise<void>
  onDeleteFile: (t: DownloadTask) => Promise<void>
  onLog: (t: DownloadTask) => Promise<void>
}): React.JSX.Element {
  const { toast } = useApp()
  const p = t.progress
  const pct = t.status === 'completed' ? 100 : (p.percent ?? null)
  const indeterminate = t.status === 'running' && pct === null
  const barClass = t.status === 'completed' ? 'done' : t.status === 'error' ? 'error' : t.status === 'paused' ? 'paused' : ''
  const act = async (fn: () => Promise<unknown>): Promise<void> => {
    try {
      await fn()
    } catch (e) {
      toast({ type: 'error', message: errorText(e) })
    }
  }

  const thumbSource: ThumbSource | null = t.thumbnail
    ? { kind: 'url', url: t.thumbnail }
    : t.status === 'completed' && t.filePath
      ? { kind: 'local', path: t.filePath }
      : t.engine !== 'ytdlp'
        ? { kind: 'remote', url: t.url, headers: t.headers }
        : null

  return (
    <div className="task">
      <Thumb source={thumbSource} width={96} height={54} />
      <div className="body">
        <div className="title" title={t.filePath ?? t.url}>
          <span className={`kind ${t.engine === 'http' ? 'file' : t.engine}`}>{t.engine === 'http' ? 'FILE' : t.engine === 'hls' ? 'HLS' : 'YT-DLP'}</span>
          {t.batchId && (
            <span className="scan-tag" style={{ marginLeft: 0, marginRight: 6 }} title="자동 다운로드 작업에서 추가된 항목">
              자동
            </span>
          )}
          {t.filePath ? fileNameOf(t.filePath) : t.title}
        </div>
        <div className="sub">{hostOf(t.url)}{t.pageUrl && t.pageUrl !== t.url ? ` · ${t.pageUrl}` : ''}</div>
        <div className={`progress ${barClass} ${indeterminate ? 'indeterminate' : ''}`}>
          <div style={{ width: `${pct ?? 0}%` }} />
        </div>
        <div className="stats">
          <span className={`status ${t.status}`}>{STATUS_LABEL[t.status]}</span>
          {p.stage && t.status === 'running' && <span>{p.stage}</span>}
          <span>
            {formatBytes(p.downloaded)}
            {p.total ? ` / ${formatBytes(p.total)}` : ''}
            {pct !== null ? ` (${pct.toFixed(1)}%)` : ''}
          </span>
          {t.status === 'running' && p.speed > 0 && <span>{formatSpeed(p.speed)}</span>}
          {t.status === 'running' && p.eta !== null && <span>남은 시간 {formatEta(p.eta)}</span>}
          {p.segmentsTotal ? <span>세그먼트 {p.segmentsDone ?? 0}/{p.segmentsTotal}</span> : null}
          {t.variant?.resolution && <span>{t.variant.resolution}</span>}
        </div>
        {t.error && <div className="error">{t.error}</div>}
      </div>
      <div className="actions">
        {t.status === 'running' || t.status === 'queued' ? (
          <button className="icon-btn" title="일시정지" onClick={() => void act(() => window.api.downloads.pause(t.id))}>
            <Icon name="pause" />
          </button>
        ) : t.status === 'paused' ? (
          <button className="icon-btn" title="이어받기" onClick={() => void act(() => window.api.downloads.resume(t.id))}>
            <Icon name="play" />
          </button>
        ) : t.status === 'error' || t.status === 'canceled' ? (
          <button className="icon-btn" title="다시 시도" onClick={() => void act(() => window.api.downloads.retry(t.id))}>
            <Icon name="reload" />
          </button>
        ) : null}
        {t.status === 'completed' && (
          <>
            <button className="icon-btn" title="재생" onClick={() => onPlay(t)}>
              <Icon name="play" />
            </button>
            <button className="icon-btn" title="기본 프로그램으로 열기" onClick={() => void act(() => window.api.downloads.openFile(t.id))}>
              <Icon name="open" />
            </button>
            <button className="icon-btn" title="폴더에서 보기" onClick={() => void act(() => window.api.downloads.showInFolder(t.id))}>
              <Icon name="folder" />
            </button>
          </>
        )}
        {(t.status === 'running' || t.status === 'queued' || t.status === 'paused') && (
          <button className="icon-btn" title="취소" onClick={() => void act(() => window.api.downloads.cancel(t.id))}>
            <Icon name="stop" />
          </button>
        )}
        <button className="icon-btn" title="로그" onClick={() => void onLog(t)}>
          <Icon name="list" />
        </button>
        {t.status === 'completed' && t.filePath && (
          <button className="icon-btn" title="파일 삭제" onClick={() => void onDeleteFile(t)}>
            <Icon name="trash" />
          </button>
        )}
        <button className="icon-btn" title="목록에서 제거" onClick={() => void onRemove(t)}>
          <Icon name="close" />
        </button>
      </div>
    </div>
  )
})
