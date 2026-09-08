import React, { useCallback, useEffect, useState } from 'react'
import type { FileEntry } from '@shared/types'
import { useApp, type PlayerItem } from '../state/AppContext'
import { Icon } from '../components/Icon'
import { useConfirm, usePrompt } from '../components/Modal'
import { Thumb, forgetThumb } from '../components/Thumb'
import { errorText, formatBytes, formatDate } from '../lib/format'

type View = 'list' | 'grid'

function loadView(): View {
  try {
    return localStorage.getItem('files.view') === 'grid' ? 'grid' : 'list'
  } catch {
    return 'list'
  }
}

export function FilesPage({ active }: { active: boolean }): React.JSX.Element {
  const { settings, play, toast, setPage } = useApp()
  const [files, setFiles] = useState<FileEntry[]>([])
  const [query, setQuery] = useState('')
  const [view, setView] = useState<View>(loadView)
  const [confirm, confirmDialog] = useConfirm()
  const [prompt, promptDialog] = usePrompt()

  const changeView = (v: View): void => {
    setView(v)
    try {
      localStorage.setItem('files.view', v)
    } catch {
      /* ignore */
    }
  }

  const refresh = useCallback(async () => {
    try {
      setFiles(await window.api.files.list())
    } catch (e) {
      toast({ type: 'error', message: errorText(e) })
    }
  }, [toast])

  useEffect(() => {
    if (active) void refresh()
  }, [active, refresh, settings?.downloadDir])

  useEffect(() => {
    if (!active) return
    const off = window.api.downloads.onUpdate((t) => {
      if (t.status === 'completed') void refresh()
    })
    return off
  }, [active, refresh])

  const toItem = (f: FileEntry): PlayerItem => ({
    id: `file:${f.path}`,
    title: f.name,
    src: `media://local/?p=${encodeURIComponent(f.path)}`,
    kind: 'local',
    path: f.path
  })

  const filtered = files.filter((f) => !query || f.name.toLowerCase().includes(query.toLowerCase()))
  const media = filtered.filter((f) => f.isMedia)
  const playFile = (f: FileEntry): void => {
    if (f.isMedia) play(toItem(f), media.map(toItem))
  }

  const rename = async (f: FileEntry): Promise<void> => {
    const name = await prompt('이름 변경', f.name, '새 파일 이름')
    if (!name || name === f.name) return
    try {
      await window.api.files.rename(f.path, name)
      forgetThumb({ kind: 'local', path: f.path })
      await refresh()
    } catch (e) {
      toast({ type: 'error', message: errorText(e) })
    }
  }

  const remove = async (f: FileEntry): Promise<void> => {
    if (!(await confirm(`휴지통으로 이동할까요?\n${f.name}`, { danger: true, title: '파일 삭제' }))) return
    try {
      await window.api.files.remove(f.path)
      forgetThumb({ kind: 'local', path: f.path })
      await refresh()
    } catch (e) {
      toast({ type: 'error', message: errorText(e) })
    }
  }

  const toVault = async (f: FileEntry): Promise<void> => {
    const st = await window.api.vault.state()
    if (!st.unlocked) {
      toast({ type: 'info', message: '개인 폴더를 먼저 설정하거나 잠금 해제해 주세요' })
      setPage('vault')
      return
    }
    if (!(await confirm(`개인 폴더로 이동할까요? 원본은 암호화된 뒤 삭제됩니다.\n${f.name}`))) return
    try {
      await window.api.vault.add([f.path])
      forgetThumb({ kind: 'local', path: f.path })
      toast({ type: 'success', message: '개인 폴더로 이동했습니다' })
      await refresh()
    } catch (e) {
      toast({ type: 'error', message: errorText(e) })
    }
  }

  const actions = (f: FileEntry): React.JSX.Element => (
    <>
      {f.isMedia && (
        <button className="icon-btn" title="재생" onClick={() => playFile(f)}>
          <Icon name="play" />
        </button>
      )}
      <button className="icon-btn" title="기본 프로그램으로 열기" onClick={() => void window.api.files.open(f.path)}>
        <Icon name="open" />
      </button>
      <button className="icon-btn" title="폴더에서 보기" onClick={() => void window.api.files.showInFolder(f.path)}>
        <Icon name="folder" />
      </button>
      <button className="icon-btn" title="이름 변경" onClick={() => void rename(f)}>
        <Icon name="more" />
      </button>
      <button className="icon-btn" title="개인 폴더로 이동" onClick={() => void toVault(f)}>
        <Icon name="lock" />
      </button>
      <button className="icon-btn" title="삭제" onClick={() => void remove(f)}>
        <Icon name="trash" />
      </button>
    </>
  )

  return (
    <>
      <div className="page-header">
        <h2>파일</h2>
        <span className="muted small ellipsis grow" title={settings?.downloadDir}>
          {settings?.downloadDir}
        </span>
        <input className="input" style={{ width: 200 }} placeholder="파일 검색" value={query} onChange={(e) => setQuery(e.target.value)} />
        <div className="seg" title="보기 방식">
          <button className={view === 'list' ? 'active' : ''} onClick={() => changeView('list')}>
            <Icon name="list" size={14} />
          </button>
          <button className={view === 'grid' ? 'active' : ''} onClick={() => changeView('grid')}>
            <Icon name="film" size={14} />
          </button>
        </div>
        <button className="btn" onClick={() => media.length && play(toItem(media[0]), media.map(toItem))} disabled={!media.length}>
          <Icon name="play" size={14} /> 모두 재생
        </button>
        <button className="btn" onClick={() => settings && void window.api.files.showInFolder(settings.downloadDir)}>
          <Icon name="folder" size={14} /> 폴더 열기
        </button>
        <button className="icon-btn" onClick={() => void refresh()} title="새로고침">
          <Icon name="reload" />
        </button>
      </div>
      <div className="page-body">
        {filtered.length === 0 ? (
          <div className="empty">다운로드 폴더에 파일이 없습니다.</div>
        ) : view === 'grid' ? (
          <div className="file-grid">
            {filtered.map((f) => (
              <div key={f.path} className="file-card" onDoubleClick={() => playFile(f)} title={f.path}>
                <Thumb source={f.isMedia ? { kind: 'local', path: f.path } : null} width="100%" height="auto" icon={f.isMedia ? 'film' : 'folder'} iconSize={30} />
                <div className="info">
                  <div className="n">{f.name}</div>
                  <div className="m">
                    <span>{formatBytes(f.size)}</span>
                    <span>{formatDate(f.mtime)}</span>
                  </div>
                </div>
                <div className="acts" onDoubleClick={(e) => e.stopPropagation()}>
                  {actions(f)}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>이름</th>
                <th style={{ width: 100 }}>크기</th>
                <th style={{ width: 140 }}>수정일</th>
                <th style={{ width: 230 }}></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((f) => (
                <tr key={f.path} onDoubleClick={() => playFile(f)}>
                  <td>
                    <div className="name row">
                      <Thumb source={f.isMedia ? { kind: 'local', path: f.path } : null} width={80} height={45} icon={f.isMedia ? 'film' : 'folder'} iconSize={18} />
                      <span className="ellipsis" title={f.path}>
                        {f.name}
                      </span>
                    </div>
                  </td>
                  <td className="muted">{formatBytes(f.size)}</td>
                  <td className="muted">{formatDate(f.mtime)}</td>
                  <td className="actions">{actions(f)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {confirmDialog}
      {promptDialog}
    </>
  )
}
