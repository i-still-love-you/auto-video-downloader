import { app } from 'electron'
import { EventEmitter } from 'node:events'
import { existsSync, promises as fs } from 'node:fs'
import path from 'node:path'
import { JsonStore } from '../storage/jsonStore'
import { localDuration } from '../thumbnails'
import { newId } from '../util'
import { findDuplicates, hostOf, pageKeyOf, sourceKeyOf, type DownloadRecord, type DuplicateMatch, type DuplicateQuery } from '@shared/dedupe'
import type { DownloadTask } from '@shared/types'

interface StoreData {
  items: DownloadRecord[]
}

const MAX_RECORDS = 20_000

/**
 * 다운로드 이력. 완료된 영상마다 페이지 주소·소스 주소·크기·길이를 남겨 두고, 다운로드 목록을 정리하거나
 * 파일을 다른 곳으로 옮긴 뒤에도 같은 영상을 다시 받지 않도록 중복을 판정한다.
 * 이벤트: 'changed'
 */
export class Library extends EventEmitter {
  private store: JsonStore<StoreData>
  private emitTimer: NodeJS.Timeout | null = null

  constructor() {
    super()
    this.store = new JsonStore<StoreData>(path.join(app.getPath('userData'), 'library.json'), () => ({ items: [] }))
  }

  async init(): Promise<void> {
    const data = await this.store.load()
    data.items = (Array.isArray(data.items) ? data.items : []).filter((r) => r && typeof r.id === 'string' && typeof r.sourceUrl === 'string')
    for (const r of data.items) {
      if (!r.sourceKey) r.sourceKey = sourceKeyOf(r.sourceUrl)
      if (r.pageUrl && !r.pageKey) r.pageKey = pageKeyOf(r.pageUrl)
      if (!r.host) r.host = hostOf(r.pageUrl || r.sourceUrl)
    }
  }

  private records(): DownloadRecord[] {
    return this.store.get().items
  }

  /** 저장된 이력 (파일 존재 여부를 조회 시점에 채워서) */
  list(): DownloadRecord[] {
    return this.records().map((r) => ({ ...r, exists: !!r.filePath && existsSync(r.filePath) }))
  }

  count(): number {
    return this.records().length
  }

  check(q: DuplicateQuery): DuplicateMatch[] {
    return findDuplicates(this.records(), q).map((m) => ({ ...m, record: { ...m.record, exists: !!m.record.filePath && existsSync(m.record.filePath) } }))
  }

  private changed(): void {
    this.store.scheduleSave()
    if (this.emitTimer) return
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null
      this.emit('changed')
    }, 200)
  }

  private upsert(rec: DownloadRecord): void {
    const items = this.records()
    const idx = items.findIndex((r) => (rec.pageKey && r.pageKey === rec.pageKey) || r.sourceKey === rec.sourceKey)
    if (idx >= 0) {
      const old = items[idx]
      items[idx] = { ...old, ...rec, id: old.id, duration: rec.duration ?? old.duration, size: rec.size ?? old.size, thumbnail: rec.thumbnail ?? old.thumbnail }
    } else {
      items.unshift(rec)
      if (items.length > MAX_RECORDS) items.length = MAX_RECORDS
    }
    this.changed()
  }

  private fromTask(task: DownloadTask, filePath: string, size: number | null, duration: number | null): DownloadRecord {
    const pageUrl = task.pageUrl && task.pageUrl !== task.url ? task.pageUrl : undefined
    return {
      id: newId(),
      title: task.title || path.basename(filePath),
      host: hostOf(pageUrl || task.url),
      pageUrl,
      pageKey: pageUrl ? pageKeyOf(pageUrl) : undefined,
      sourceUrl: task.url,
      sourceKey: sourceKeyOf(task.url),
      engine: task.engine,
      size,
      duration,
      resolution: task.variant?.resolution,
      filePath,
      thumbnail: task.thumbnail && !task.thumbnail.startsWith('media://') ? task.thumbnail : undefined,
      downloadedAt: task.completedAt ?? Date.now()
    }
  }

  /** 다운로드가 끝났을 때 기록한다. 길이는 ffprobe 가 있으면 파일에서 읽는다. */
  async recordCompleted(task: DownloadTask): Promise<void> {
    if (!task.filePath) return
    let size: number | null = task.size ?? null
    try {
      size = (await fs.stat(task.filePath)).size
    } catch {
      /* 크기를 못 읽으면 작업의 값 사용 */
    }
    let duration: number | null = task.duration ?? null
    if (!duration) duration = await localDuration(task.filePath).catch(() => null)
    this.upsert(this.fromTask(task, task.filePath, size, duration))
  }

  /** 이력이 생기기 전에 완료된 다운로드 목록을 한 번 옮겨 담는다 (길이는 모르는 채로) */
  importTasks(tasks: DownloadTask[]): number {
    let added = 0
    const items = this.records()
    for (const t of tasks) {
      if (t.status !== 'completed' || !t.filePath) continue
      const sk = sourceKeyOf(t.url)
      if (items.some((r) => r.sourceKey === sk)) continue
      items.push(this.fromTask(t, t.filePath, t.size ?? null, t.duration ?? null))
      added++
    }
    if (added) this.changed()
    return added
  }

  remove(id: string): void {
    const items = this.records()
    const idx = items.findIndex((r) => r.id === id)
    if (idx < 0) return
    items.splice(idx, 1)
    this.changed()
  }

  clear(): void {
    this.store.get().items = []
    this.changed()
  }

  /** 파일 이름을 바꾸거나 옮겼을 때 이력의 경로를 따라가게 한다 */
  renamePath(from: string, to: string): void {
    let hit = false
    for (const r of this.records()) {
      if (r.filePath === from) {
        r.filePath = to
        hit = true
      }
    }
    if (hit) this.changed()
  }

  async flush(): Promise<void> {
    if (this.emitTimer) {
      clearTimeout(this.emitTimer)
      this.emitTimer = null
    }
    await this.store.flush()
  }
}
