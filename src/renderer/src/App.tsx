import React, { useEffect } from 'react'
import type { PageId } from '@shared/types'
import { useApp } from './state/AppContext'
import { useDownloads } from './hooks/useDownloads'
import { useBatch } from './hooks/useBatch'
import { Icon } from './components/Icon'
import { Toasts } from './components/Toasts'
import { AnalyzeDialog } from './components/AnalyzeDialog'
import { BrowserPage } from './pages/BrowserPage'
import { DownloadsPage } from './pages/DownloadsPage'
import { BatchPage } from './pages/BatchPage'
import { FilesPage } from './pages/FilesPage'
import { PlayerPage } from './pages/PlayerPage'
import { VaultPage } from './pages/VaultPage'
import { SettingsPage } from './pages/SettingsPage'

const NAV: Array<{ id: PageId; label: string; icon: string }> = [
  { id: 'browser', label: '브라우저', icon: 'globe' },
  { id: 'downloads', label: '다운로드', icon: 'download' },
  { id: 'batch', label: '자동 다운로드', icon: 'layers' },
  { id: 'files', label: '파일', icon: 'folder' },
  { id: 'player', label: '플레이어', icon: 'play' },
  { id: 'vault', label: '개인 폴더', icon: 'lock' },
  { id: 'settings', label: '설정', icon: 'settings' }
]

export function App(): React.JSX.Element {
  const { page, setPage, modalCount } = useApp()
  const tasks = useDownloads()
  const jobs = useBatch()
  const active = tasks.filter((t) => t.status === 'running' || t.status === 'queued').length
  const runningJobs = jobs.filter((j) => j.status === 'running').length

  useEffect(() => {
    window.api.browser.setVisible(page === 'browser' && modalCount === 0)
  }, [page, modalCount])

  return (
    <div className="app">
      <nav className="sidebar">
        <div className="brand">
          <Icon name="film" size={22} />
          <span>Video Downloader</span>
        </div>
        {NAV.map((n) => (
          <button key={n.id} className={`nav-item ${page === n.id ? 'active' : ''}`} onClick={() => setPage(n.id)}>
            <Icon name={n.icon} />
            <span>{n.label}</span>
            {n.id === 'downloads' && active > 0 && <em className="badge">{active}</em>}
            {n.id === 'batch' && runningJobs > 0 && <em className="badge">{runningJobs}</em>}
          </button>
        ))}
        <div className="sidebar-foot">
          <span className="muted">Ctrl+T 새 탭 · Ctrl+1~9 탭 이동 · Ctrl+Shift+T 닫은 탭 열기</span>
        </div>
      </nav>
      <main className="content">
        <div className="page" hidden={page !== 'browser'}>
          <BrowserPage />
        </div>
        <div className="page" hidden={page !== 'downloads'}>
          <DownloadsPage />
        </div>
        <div className="page" hidden={page !== 'batch'}>
          <BatchPage active={page === 'batch'} />
        </div>
        <div className="page" hidden={page !== 'files'}>
          <FilesPage active={page === 'files'} />
        </div>
        <div className="page" hidden={page !== 'player'}>
          <PlayerPage active={page === 'player'} />
        </div>
        <div className="page" hidden={page !== 'vault'}>
          <VaultPage active={page === 'vault'} />
        </div>
        <div className="page" hidden={page !== 'settings'}>
          <SettingsPage active={page === 'settings'} />
        </div>
      </main>
      <AnalyzeDialog />
      <Toasts />
    </div>
  )
}
