import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { AppNotification, DetectedMedia, PageId, Settings } from '@shared/types'

export interface PlayerItem {
  id: string
  title: string
  src: string
  kind: 'local' | 'hls' | 'remote'
  path?: string
}

export interface AnalyzeRequest {
  url: string
  headers?: Record<string, string>
  pageUrl?: string
  pageTitle?: string
  item?: DetectedMedia
}

export interface Toast extends AppNotification {
  id: number
}

interface AppContextValue {
  page: PageId
  setPage: (p: PageId) => void
  toasts: Toast[]
  toast: (n: AppNotification) => void
  dismissToast: (id: number) => void
  settings: Settings | null
  saveSettings: (patch: Partial<Settings>) => Promise<void>
  reloadSettings: () => Promise<void>
  analyzeRequest: AnalyzeRequest | null
  requestAnalyze: (r: AnalyzeRequest) => void
  closeAnalyze: () => void
  modalCount: number
  pushModal: () => void
  popModal: () => void
  playerQueue: PlayerItem[]
  playerIndex: number
  play: (item: PlayerItem, queue?: PlayerItem[]) => void
  setPlayerIndex: (i: number) => void
  focusAddressToken: number
  /** 자동 다운로드 페이지에 미리 채울 목록 주소 */
  batchPrefill: string | null
  openBatch: (url: string) => void
  clearBatchPrefill: () => void
}

const AppContext = createContext<AppContextValue | null>(null)

export function AppProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [page, setPage] = useState<PageId>('browser')
  const [toasts, setToasts] = useState<Toast[]>([])
  const [settings, setSettings] = useState<Settings | null>(null)
  const [analyzeRequest, setAnalyzeRequest] = useState<AnalyzeRequest | null>(null)
  const [modalCount, setModalCount] = useState(0)
  const [playerQueue, setPlayerQueue] = useState<PlayerItem[]>([])
  const [playerIndex, setPlayerIndex] = useState(0)
  const [focusAddressToken, setFocusAddressToken] = useState(0)
  const [batchPrefill, setBatchPrefill] = useState<string | null>(null)
  const toastId = useRef(0)

  const openBatch = useCallback((url: string) => {
    setBatchPrefill(url)
    setPage('batch')
  }, [])
  const clearBatchPrefill = useCallback(() => setBatchPrefill(null), [])

  const toast = useCallback((n: AppNotification) => {
    const id = ++toastId.current
    setToasts((prev) => [...prev.slice(-4), { ...n, id }])
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), n.type === 'error' ? 7000 : n.action ? 9000 : 4000)
  }, [])

  const dismissToast = useCallback((id: number) => setToasts((prev) => prev.filter((t) => t.id !== id)), [])

  const reloadSettings = useCallback(async () => {
    setSettings(await window.api.settings.get())
  }, [])

  const saveSettings = useCallback(async (patch: Partial<Settings>) => {
    setSettings(await window.api.settings.set(patch))
  }, [])

  const requestAnalyze = useCallback((r: AnalyzeRequest) => setAnalyzeRequest(r), [])
  const closeAnalyze = useCallback(() => setAnalyzeRequest(null), [])
  const pushModal = useCallback(() => setModalCount((c) => c + 1), [])
  const popModal = useCallback(() => setModalCount((c) => Math.max(0, c - 1)), [])

  const play = useCallback((item: PlayerItem, queue?: PlayerItem[]) => {
    const q = queue && queue.length ? queue : [item]
    const idx = Math.max(
      0,
      q.findIndex((x) => x.id === item.id)
    )
    setPlayerQueue(q)
    setPlayerIndex(idx)
    setPage('player')
  }, [])

  useEffect(() => {
    void reloadSettings()
    const offNotify = window.api.app.onNotify(toast)
    const offNav = window.api.app.onNavigate((ev) => {
      setPage(ev.page)
      if (ev.focusAddress) setFocusAddressToken((t) => t + 1)
      if (ev.analyzeUrl) setAnalyzeRequest({ url: ev.analyzeUrl, pageUrl: ev.pageUrl })
      if (ev.batchUrl) setBatchPrefill(ev.batchUrl)
    })
    return () => {
      offNotify()
      offNav()
    }
  }, [reloadSettings, toast])

  const value = useMemo<AppContextValue>(
    () => ({
      page,
      setPage,
      toasts,
      toast,
      dismissToast,
      settings,
      saveSettings,
      reloadSettings,
      analyzeRequest,
      requestAnalyze,
      closeAnalyze,
      modalCount,
      pushModal,
      popModal,
      playerQueue,
      playerIndex,
      play,
      setPlayerIndex,
      focusAddressToken,
      batchPrefill,
      openBatch,
      clearBatchPrefill
    }),
    [
      page,
      toasts,
      toast,
      dismissToast,
      settings,
      saveSettings,
      reloadSettings,
      analyzeRequest,
      requestAnalyze,
      closeAnalyze,
      modalCount,
      pushModal,
      popModal,
      playerQueue,
      playerIndex,
      play,
      focusAddressToken,
      batchPrefill,
      openBatch,
      clearBatchPrefill
    ]
  )

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>
}

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext)
  if (!ctx) throw new Error('AppProvider missing')
  return ctx
}
