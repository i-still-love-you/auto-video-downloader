import { useEffect, useState } from 'react'
import type { BatchJob } from '@shared/types'

/** 자동(일괄) 다운로드 작업 목록을 메인 프로세스와 동기화한다 */
export function useBatch(): BatchJob[] {
  const [jobs, setJobs] = useState<BatchJob[]>([])
  useEffect(() => {
    let alive = true
    void window.api.batch.list().then((list) => alive && setJobs(list))
    const offUpdate = window.api.batch.onUpdate((j) =>
      setJobs((prev) => {
        const i = prev.findIndex((x) => x.id === j.id)
        if (i < 0) return [j, ...prev]
        const next = [...prev]
        next[i] = j
        return next
      })
    )
    const offRemoved = window.api.batch.onRemoved((id) => setJobs((prev) => prev.filter((x) => x.id !== id)))
    return () => {
      alive = false
      offUpdate()
      offRemoved()
    }
  }, [])
  return jobs
}
