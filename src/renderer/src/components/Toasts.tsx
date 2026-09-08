import React from 'react'
import { useApp } from '../state/AppContext'
import { Icon } from './Icon'

export function Toasts(): React.JSX.Element {
  const { toasts, dismissToast } = useApp()
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.type}`} onClick={() => dismissToast(t.id)}>
          <Icon name={t.type === 'error' ? 'warning' : t.type === 'success' ? 'check' : 'info'} size={16} />
          <span>{t.message}</span>
        </div>
      ))}
    </div>
  )
}
