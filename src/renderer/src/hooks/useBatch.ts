import { useEffect, useState } from 'react'
import type { BatchItem, BatchJob } from '@shared/types'

/** 두 항목의 필드가 모두 같은지 (얕은 비교) */
function sameItem(a: BatchItem, b: BatchItem): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]) as Set<keyof BatchItem>
  for (const k of keys) if (a[k] !== b[k]) return false
  return true
}

/**
 * 메인 프로세스가 보내는 작업 객체는 매번 새로 만들어진다(IPC 복사). 내용이 같은 항목은 이전 객체를 그대로 써서
 * 참조가 유지되게 해야 memo 된 항목 행이 실제로 바뀐 항목만 다시 그린다.
 */
function mergeJob(prev: BatchJob | undefined, next: BatchJob): BatchJob {
  if (!prev) return next
  const old = new Map(prev.items.map((it) => [it.id, it]))
  let unchanged = prev.items.length === next.items.length
  const items = next.items.map((it, i) => {
    const o = old.get(it.id)
    if (o && sameItem(o, it)) {
      if (prev.items[i] !== o) unchanged = false
      return o
    }
    unchanged = false
    return it
  })
  return { ...next, items: unchanged ? prev.items : items }
}

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
        next[i] = mergeJob(prev[i], j)
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
