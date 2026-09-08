import { useEffect, useState } from 'react'
import type { DownloadTask } from '@shared/types'

export function useDownloads(): DownloadTask[] {
  const [tasks, setTasks] = useState<DownloadTask[]>([])
  useEffect(() => {
    let alive = true
    void window.api.downloads.list().then((list) => alive && setTasks(list))
    const offUpdate = window.api.downloads.onUpdate((t) =>
      setTasks((prev) => {
        const i = prev.findIndex((x) => x.id === t.id)
        if (i < 0) return [t, ...prev]
        const next = [...prev]
        next[i] = t
        return next
      })
    )
    const offRemoved = window.api.downloads.onRemoved((id) => setTasks((prev) => prev.filter((x) => x.id !== id)))
    return () => {
      alive = false
      offUpdate()
      offRemoved()
    }
  }, [])
  return tasks
}
