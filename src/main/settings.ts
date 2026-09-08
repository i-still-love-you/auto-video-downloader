import { app } from 'electron'
import path from 'node:path'
import { JsonStore } from './storage/jsonStore'
import type { AdblockSettings, PopupBlockSettings, Settings } from '@shared/types'

export function defaultPopupBlock(): PopupBlockSettings {
  return { enabled: true, allowlist: [] }
}

export const DEFAULT_ADBLOCK_LISTS = ['adguard-base', 'adguard-tracking', 'list-kr', 'ublock-unbreak']

export function defaultAdblock(): AdblockSettings {
  return { enabled: true, lists: [...DEFAULT_ADBLOCK_LISTS], customRules: '', allowlist: [], doh: false }
}

function safePath(name: Parameters<typeof app.getPath>[0], fallback: string): string {
  try {
    return app.getPath(name)
  } catch {
    return fallback
  }
}

export function defaultSettings(): Settings {
  const home = app.getPath('home')
  const videos = safePath('videos', safePath('downloads', home))
  return {
    downloadDir: path.join(videos, 'VideoDownloader'),
    vaultDir: path.join(app.getPath('userData'), 'vault'),
    maxConcurrent: 3,
    connections: 8,
    preferredQuality: 'ask',
    remuxToMp4: true,
    searchEngineId: 'google',
    homeUrl: '',
    toolPaths: {},
    autoUpdate: true,
    detectMinSize: 200 * 1024,
    interceptBrowserDownloads: true,
    adblock: defaultAdblock(),
    popupBlock: defaultPopupBlock()
  }
}

let store: JsonStore<Settings> | null = null

export async function initSettings(): Promise<Settings> {
  store = new JsonStore<Settings>(path.join(app.getPath('userData'), 'settings.json'), defaultSettings)
  const s = await store.load()
  // 중첩 객체는 얕은 병합이 안 되므로 기본값을 채워 넣는다
  s.adblock = { ...defaultAdblock(), ...(s.adblock ?? {}) }
  s.popupBlock = { ...defaultPopupBlock(), ...(s.popupBlock ?? {}) }
  return s
}

export function getSettings(): Settings {
  if (!store) throw new Error('settings not initialized')
  return store.get()
}

export function updateSettings(patch: Partial<Settings>): Settings {
  if (!store) throw new Error('settings not initialized')
  const clean: Partial<Settings> = { ...patch }
  if (clean.maxConcurrent !== undefined) clean.maxConcurrent = Math.min(10, Math.max(1, Math.floor(clean.maxConcurrent)))
  if (clean.connections !== undefined) clean.connections = Math.min(32, Math.max(1, Math.floor(clean.connections)))
  if (clean.detectMinSize !== undefined) clean.detectMinSize = Math.max(0, Math.floor(clean.detectMinSize))
  if (clean.adblock !== undefined) clean.adblock = { ...store.get().adblock, ...clean.adblock }
  if (clean.popupBlock !== undefined) clean.popupBlock = { ...store.get().popupBlock, ...clean.popupBlock }
  return store.set(clean)
}

export async function flushSettings(): Promise<void> {
  await store?.flush()
}
