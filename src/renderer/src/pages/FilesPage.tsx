import React, { useCallback, useEffect, useState } from 'react'
import type { FileEntry } from '@shared/types'
import { useApp, type PlayerItem } from '../state/AppContext'
import { Icon } from '../components/Icon'
import { useConfirm, usePrompt } from '../components/Modal'
import { errorText, formatBytes, formatDate } from '../lib/format'

export function FilesPage({ active }: { active: boolean }): React.JSX.Element {
  const { settings, play, toast, setPage } = useApp()
  const [files, setFiles] = useState<FileEntry[]>([])
  const [query, setQuery] = useState('')
  const [confirm, confirmDialog] = useConfirm()
  const [prompt, promptDialog] = usePrompt()

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

  const rename = async (f: FileEntry): Promise<void> => {
    const name = await prompt('이름 변경', f.name, '새 파일 이름')
    if (!name || name === f.name) return
    try {
      await window.api.files.rename(f.path, name)
      await refresh()
    } catch (e) {
      toast({ type: 'error', message: errorText(e) })
    }
  }

  const remove = async (f: FileEntry): Promise<void> => {
    if (!(await confirm(`휴지통으로 이동할까요?\n${f.name}`, { danger: true, title: '파일 삭제' }))) return
    try {
      await window.api.files.remove(f.path)
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
      toast({ type: 'success', message: '개인 폴더로 이동했습니다' })
      await refresh()
    } catch (e) {
      toast({ type: 'error', message: errorText(e) })
    }
  }

  return (
    <>
      <div className="page-header">
        <h2>파일</h2>
        <span className="muted small ellipsis grow" title={settings?.downloadDir}>
          {settings?.downloadDir}
        </span>
        <input className="input" style={{ width: 220 }} placeholder="파일 검색" value={query} onChange={(e) => setQuery(e.target.value)} />
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
                <tr key={f.path} onDoubleClick={() => f.isMedia && play(toItem(f), media.map(toItem))}>
                  <td>
                    <div className="name row">
                      <Icon name={f.isMedia ? 'film' : 'folder'} size={16} className="muted" />
                      <span className="ellipsis" title={f.path}>
                        {f.name}
                      </span>
                    </div>
                  </td>
                  <td className="muted">{formatBytes(f.size)}</td>
                  <td className="muted">{formatDate(f.mtime)}</td>
                  <td className="actions">
                    {f.isMedia && (
                      <button className="icon-btn" title="재생" onClick={() => play(toItem(f), media.map(toItem))}>
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
                  </td>
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
