import { promises as fs } from 'node:fs'
import path from 'node:path'

/** 디바운스 저장을 지원하는 단순 JSON 파일 저장소 (원자적 쓰기). */
export class JsonStore<T extends object> {
  private data: T
  private timer: NodeJS.Timeout | null = null
  private writing: Promise<void> = Promise.resolve()
  private dirty = false

  constructor(
    private readonly file: string,
    private readonly defaults: () => T
  ) {
    this.data = defaults()
  }

  async load(): Promise<T> {
    try {
      const raw = await fs.readFile(this.file, 'utf8')
      const parsed = JSON.parse(raw) as Partial<T>
      this.data = { ...this.defaults(), ...parsed }
    } catch {
      this.data = this.defaults()
    }
    return this.data
  }

  get(): T {
    return this.data
  }

  set(patch: Partial<T>): T {
    Object.assign(this.data, patch)
    this.scheduleSave()
    return this.data
  }

  update(fn: (data: T) => void): T {
    fn(this.data)
    this.scheduleSave()
    return this.data
  }

  scheduleSave(delay = 300): void {
    this.dirty = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => void this.flush(), delay)
  }

  /** 디바운스가 아닌 스로틀 저장: 이미 예약된 저장이 있으면 그대로 둔다. */
  scheduleSaveThrottled(maxDelay = 2000): void {
    this.dirty = true
    if (this.timer) return
    this.timer = setTimeout(() => void this.flush(), maxDelay)
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (!this.dirty) return
    this.dirty = false
    const snapshot = JSON.stringify(this.data, null, 2)
    this.writing = this.writing.then(async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true })
      const tmp = `${this.file}.tmp`
      await fs.writeFile(tmp, snapshot, 'utf8')
      await fs.rename(tmp, this.file)
    })
    await this.writing.catch(() => undefined)
  }
}
