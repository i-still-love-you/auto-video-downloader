import { useEffect, useState } from 'react'
import type { DownloadRecord } from '@shared/dedupe'

/** 다운로드 이력을 메인 프로세스와 동기화한다 (중복 배지·경고·이력 목록용) */
export function useLibrary(): DownloadRecord[] {
  const [records, setRecords] = useState<DownloadRecord[]>([])
  useEffect(() => {
    let alive = true
    const load = (): void => void window.api.library.list().then((list) => alive && setRecords(list))
    load()
    const off = window.api.library.onChanged(load)
    return () => {
      alive = false
      off()
    }
  }, [])
  return records
}
