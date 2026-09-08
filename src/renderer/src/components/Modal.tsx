import React, { useCallback, useEffect, useState } from 'react'
import { useApp } from '../state/AppContext'
import { Icon } from './Icon'

interface ModalProps {
  title: string
  onClose: () => void
  children: React.ReactNode
  width?: number
  footer?: React.ReactNode
}

export function Modal({ title, onClose, children, width = 560, footer }: ModalProps): React.JSX.Element {
  const { pushModal, popModal } = useApp()
  useEffect(() => {
    pushModal()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      popModal()
      window.removeEventListener('keydown', onKey)
    }
  }, [pushModal, popModal, onClose])

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ width }} role="dialog" aria-modal="true">
        <header className="modal-header">
          <h3>{title}</h3>
          <button className="icon-btn" onClick={onClose} title="닫기">
            <Icon name="close" />
          </button>
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-footer">{footer}</footer>}
      </div>
    </div>
  )
}

interface ConfirmState {
  message: string
  title?: string
  danger?: boolean
  resolve: (ok: boolean) => void
}

/** 확인 다이얼로그 훅: const [confirm, dialog] = useConfirm() */
export function useConfirm(): [(message: string, opts?: { title?: string; danger?: boolean }) => Promise<boolean>, React.ReactNode] {
  const [state, setState] = useState<ConfirmState | null>(null)
  // 참조가 바뀌지 않아야 이 함수를 쓰는 memo 된 행 컴포넌트가 불필요하게 다시 그려지지 않는다
  const confirm = useCallback(
    (message: string, opts?: { title?: string; danger?: boolean }): Promise<boolean> => new Promise<boolean>((resolve) => setState({ message, resolve, ...opts })),
    []
  )
  const close = (ok: boolean): void => {
    state?.resolve(ok)
    setState(null)
  }
  const dialog = state ? (
    <Modal
      title={state.title ?? '확인'}
      onClose={() => close(false)}
      width={420}
      footer={
        <>
          <button className="btn" onClick={() => close(false)}>
            취소
          </button>
          <button className={`btn ${state.danger ? 'danger' : 'primary'}`} onClick={() => close(true)} autoFocus>
            확인
          </button>
        </>
      }
    >
      <p style={{ whiteSpace: 'pre-wrap' }}>{state.message}</p>
    </Modal>
  ) : null
  return [confirm, dialog]
}

/** 입력 다이얼로그 훅 */
export function usePrompt(): [(title: string, initial?: string, label?: string) => Promise<string | null>, React.ReactNode] {
  const [state, setState] = useState<{ title: string; label?: string; value: string; resolve: (v: string | null) => void } | null>(null)
  const prompt = useCallback(
    (title: string, initial = '', label?: string): Promise<string | null> => new Promise((resolve) => setState({ title, label, value: initial, resolve })),
    []
  )
  const close = (ok: boolean): void => {
    state?.resolve(ok ? state.value : null)
    setState(null)
  }
  const dialog = state ? (
    <Modal
      title={state.title}
      onClose={() => close(false)}
      width={460}
      footer={
        <>
          <button className="btn" onClick={() => close(false)}>
            취소
          </button>
          <button className="btn primary" onClick={() => close(true)}>
            확인
          </button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault()
          close(true)
        }}
      >
        {state.label && <label className="field-label">{state.label}</label>}
        <input className="input" autoFocus value={state.value} onChange={(e) => setState({ ...state, value: e.target.value })} />
      </form>
    </Modal>
  ) : null
  return [prompt, dialog]
}
