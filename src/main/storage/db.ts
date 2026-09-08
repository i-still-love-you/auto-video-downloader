import { app } from 'electron'
import path from 'node:path'
import { JsonStore } from './jsonStore'
import { newId } from '../util'
import type { Bookmark, HistoryEntry } from '@shared/types'

interface HistoryData {
  entries: HistoryEntry[]
}
interface BookmarkData {
  items: Bookmark[]
}

const HISTORY_LIMIT = 5000

let history: JsonStore<HistoryData>
let bookmarks: JsonStore<BookmarkData>

export async function initDb(): Promise<void> {
  const dir = app.getPath('userData')
  history = new JsonStore<HistoryData>(path.join(dir, 'history.json'), () => ({ entries: [] }))
  bookmarks = new JsonStore<BookmarkData>(path.join(dir, 'bookmarks.json'), () => ({ items: [] }))
  await Promise.all([history.load(), bookmarks.load()])
}

export async function flushDb(): Promise<void> {
  await Promise.all([history?.flush(), bookmarks?.flush()])
}

// ---------- 방문 기록 ----------

export function addHistory(url: string, title: string): void {
  if (!url || url === 'about:blank' || url.startsWith('data:') || url.startsWith('devtools:')) return
  history.update((d) => {
    const last = d.entries[0]
    if (last && last.url === url && Date.now() - last.visitedAt < 60_000) {
      last.title = title || last.title
      last.visitedAt = Date.now()
      return
    }
    d.entries.unshift({ id: newId(), url, title: title || url, visitedAt: Date.now() })
    if (d.entries.length > HISTORY_LIMIT) d.entries.length = HISTORY_LIMIT
  })
}

export function updateHistoryTitle(url: string, title: string): void {
  if (!title) return
  history.update((d) => {
    const e = d.entries.find((x) => x.url === url)
    if (e) e.title = title
  })
}

export function listHistory(query = '', limit = 300): HistoryEntry[] {
  const q = query.trim().toLowerCase()
  const all = history.get().entries
  const filtered = q ? all.filter((e) => e.url.toLowerCase().includes(q) || e.title.toLowerCase().includes(q)) : all
  return filtered.slice(0, limit)
}

export function removeHistory(id: string): void {
  history.update((d) => {
    d.entries = d.entries.filter((e) => e.id !== id)
  })
}

export function clearHistory(): void {
  history.update((d) => {
    d.entries = []
  })
}

// ---------- 즐겨찾기 ----------

export function listBookmarks(): Bookmark[] {
  return bookmarks.get().items
}

export function addBookmark(url: string, title: string): Bookmark {
  const existing = bookmarks.get().items.find((b) => b.url === url)
  if (existing) return existing
  const item: Bookmark = { id: newId(), url, title: title || url, addedAt: Date.now() }
  bookmarks.update((d) => {
    d.items.unshift(item)
  })
  return item
}

export function removeBookmark(id: string): void {
  bookmarks.update((d) => {
    d.items = d.items.filter((b) => b.id !== id && b.url !== id)
  })
}
