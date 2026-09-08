import React, { useCallback, useEffect, useState } from 'react'
import type { VaultState } from '@shared/types'
import { useApp } from '../state/AppContext'
import { Icon } from '../components/Icon'
import { Modal, useConfirm } from '../components/Modal'
import { errorText, formatBytes, formatDate } from '../lib/format'

export function VaultPage({ active }: { active: boolean }): React.JSX.Element {
  const { play, toast, settings } = useApp()
  const [state, setState] = useState<VaultState>({ initialized: false, unlocked: false, items: [] })
  const [pin, setPin] = useState('')
  const [pin2, setPin2] = useState('')
  const [busy, setBusy] = useState(false)
  const [changing, setChanging] = useState(false)
  const [oldPin, setOldPin] = useState('')
  const [newPin, setNewPin] = useState('')
  const [confirm, confirmDialog] = useConfirm()

  const refresh = useCallback(async () => setState(await window.api.vault.state()), [])

  useEffect(() => {
    if (active) void refresh()
  }, [active, refresh, settings?.vaultDir])

  const run = async (fn: () => Promise<unknown>, success?: string): Promise<void> => {
    setBusy(true)
    try {
      await fn()
      await refresh()
      if (success) toast({ type: 'success', message: success })
    } catch (e) {
      toast({ type: 'error', message: errorText(e) })
    } finally {
      setBusy(false)
    }
  }

  const setup = (e: React.FormEvent): void => {
    e.preventDefault()
    if (pin !== pin2) {
      toast({ type: 'error', message: 'PIN 이 서로 다릅니다' })
      return
    }
    void run(() => window.api.vault.setup(pin), '개인 폴더를 만들었습니다').then(() => {
      setPin('')
      setPin2('')
    })
  }

  const unlock = (e: React.FormEvent): void => {
    e.preventDefault()
    void run(() => window.api.vault.unlock(pin)).then(() => setPin(''))
  }

  const addFiles = async (): Promise<void> => {
    const paths = await window.api.files.pickFiles()
    if (!paths.length) return
    if (!(await confirm(`${paths.length}개 파일을 암호화해 개인 폴더로 이동할까요? 원본은 삭제됩니다.`))) return
    await run(() => window.api.vault.add(paths), '개인 폴더에 추가했습니다')
  }

  const playItem = async (id: string, name: string): Promise<void> => {
    try {
      const src = await window.api.vault.open(id)
      play({ id: `vault:${id}`, title: name, src, kind: 'local' })
    } catch (e) {
      toast({ type: 'error', message: errorText(e) })
    }
  }

  const exportItem = async (id: string): Promise<void> => {
    try {
      const p = await window.api.vault.export(id)
      if (p) toast({ type: 'success', message: `내보냈습니다: ${p}` })
    } catch (e) {
      toast({ type: 'error', message: errorText(e) })
    }
  }

  const removeItem = async (id: string, name: string): Promise<void> => {
    if (!(await confirm(`영구 삭제할까요?\n${name}`, { danger: true, title: '삭제' }))) return
    await run(() => window.api.vault.remove(id), '삭제했습니다')
  }

  if (!state.initialized) {
    return (
      <div className="page-body">
        <form className="pin-box" onSubmit={setup}>
          <Icon name="shield" size={36} className="muted" />
          <h3>개인 폴더 만들기</h3>
          <p>PIN 으로 보호되는 암호화 폴더입니다. PIN 을 잊으면 복구할 수 없습니다.</p>
          <input className="input" type="password" placeholder="PIN (4자 이상)" value={pin} onChange={(e) => setPin(e.target.value)} autoComplete="new-password" />
          <input className="input" type="password" placeholder="PIN 확인" value={pin2} onChange={(e) => setPin2(e.target.value)} autoComplete="new-password" />
          <button className="btn primary" type="submit" disabled={busy || pin.length < 4} style={{ width: '100%', justifyContent: 'center' }}>
            만들기
          </button>
        </form>
      </div>
    )
  }

  if (!state.unlocked) {
    return (
      <div className="page-body">
        <form className="pin-box" onSubmit={unlock}>
          <Icon name="lock" size={36} className="muted" />
          <h3>개인 폴더 잠김</h3>
          <p>PIN 을 입력해 잠금을 해제하세요.</p>
          <input className="input" type="password" placeholder="PIN" value={pin} onChange={(e) => setPin(e.target.value)} autoFocus autoComplete="current-password" />
          <button className="btn primary" type="submit" disabled={busy || !pin} style={{ width: '100%', justifyContent: 'center' }}>
            잠금 해제
          </button>
        </form>
        {confirmDialog}
      </div>
    )
  }

  return (
    <>
      <div className="page-header">
        <h2>개인 폴더</h2>
        <span className="muted small grow">{state.items.length}개 항목 · AES-256 암호화</span>
        <button className="btn primary" onClick={() => void addFiles()} disabled={busy}>
          <Icon name="plus" size={14} /> 파일 추가
        </button>
        <button className="btn" onClick={() => setChanging(true)}>
          PIN 변경
        </button>
        <button className="btn" onClick={() => void run(() => window.api.vault.lock(), '잠갔습니다')}>
          <Icon name="lock" size={14} /> 잠금
        </button>
      </div>
      <div className="page-body">
        {state.items.length === 0 ? (
          <div className="empty">비어 있습니다. 파일 페이지의 자물쇠 아이콘이나 위의 "파일 추가"로 넣을 수 있습니다.</div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>이름</th>
                <th style={{ width: 100 }}>크기</th>
                <th style={{ width: 140 }}>추가일</th>
                <th style={{ width: 150 }}></th>
              </tr>
            </thead>
            <tbody>
              {state.items.map((it) => (
                <tr key={it.id} onDoubleClick={() => void playItem(it.id, it.name)}>
                  <td>
                    <div className="name row">
                      <Icon name="film" size={16} className="muted" />
                      <span className="ellipsis">{it.name}</span>
                    </div>
                  </td>
                  <td className="muted">{formatBytes(it.size)}</td>
                  <td className="muted">{formatDate(it.addedAt)}</td>
                  <td className="actions">
                    <button className="icon-btn" title="재생" onClick={() => void playItem(it.id, it.name)}>
                      <Icon name="play" />
                    </button>
                    <button className="icon-btn" title="내보내기 (복호화)" onClick={() => void exportItem(it.id)}>
                      <Icon name="export" />
                    </button>
                    <button className="icon-btn" title="삭제" onClick={() => void removeItem(it.id, it.name)}>
                      <Icon name="trash" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {changing && (
        <Modal
          title="PIN 변경"
          onClose={() => setChanging(false)}
          width={400}
          footer={
            <>
              <button className="btn" onClick={() => setChanging(false)}>
                취소
              </button>
              <button
                className="btn primary"
                disabled={busy || newPin.length < 4}
                onClick={() =>
                  void run(() => window.api.vault.changePin(oldPin, newPin), 'PIN 을 변경했습니다').then(() => {
                    setChanging(false)
                    setOldPin('')
                    setNewPin('')
                  })
                }
              >
                변경
              </button>
            </>
          }
        >
          <div className="field">
            <label className="field-label">현재 PIN</label>
            <input className="input" type="password" value={oldPin} onChange={(e) => setOldPin(e.target.value)} autoFocus />
          </div>
          <div className="field">
            <label className="field-label">새 PIN (4자 이상)</label>
            <input className="input" type="password" value={newPin} onChange={(e) => setNewPin(e.target.value)} />
          </div>
        </Modal>
      )}
      {confirmDialog}
    </>
  )
}
