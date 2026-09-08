import { app } from 'electron'
import crypto from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, promises as fs } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import path from 'node:path'
import type { VaultItem, VaultState } from '@shared/types'
import { ensureDir, newId, rmrf, sanitizeFilename, uniquePath } from '../util'

interface Meta {
  version: 1
  salt: string
  wrapIv: string
  wrappedKey: string
  wrapTag: string
  items: VaultItem[]
}

const MAGIC = Buffer.from('VDLV1')
const HEADER_LEN = MAGIC.length + 12
const TAG_LEN = 16
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 }

function scrypt(pin: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    crypto.scrypt(pin.normalize('NFKC'), salt, 32, SCRYPT, (err, key) => (err ? reject(err) : resolve(key)))
  )
}

/** PIN 으로 보호되는 암호화 폴더. 파일은 AES-256-GCM 으로 개별 암호화한다. */
export class Vault {
  private key: Buffer | null = null
  private meta: Meta | null = null

  constructor(private readonly getDir: () => string) {}

  private metaPath(): string {
    return path.join(this.getDir(), 'vault.json')
  }

  tempDir(): string {
    return path.join(app.getPath('temp'), 'vdl-vault')
  }

  private async loadMeta(): Promise<Meta | null> {
    try {
      this.meta = JSON.parse(await fs.readFile(this.metaPath(), 'utf8')) as Meta
    } catch {
      this.meta = null
    }
    return this.meta
  }

  private async saveMeta(): Promise<void> {
    if (!this.meta) return
    await ensureDir(this.getDir())
    const tmp = `${this.metaPath()}.tmp`
    await fs.writeFile(tmp, JSON.stringify(this.meta, null, 2), 'utf8')
    await fs.rename(tmp, this.metaPath())
  }

  async state(): Promise<VaultState> {
    const meta = await this.loadMeta()
    return {
      initialized: !!meta,
      unlocked: !!this.key && !!meta,
      items: this.key && meta ? [...meta.items].sort((a, b) => b.addedAt - a.addedAt) : []
    }
  }

  private requireKey(): Buffer {
    if (!this.key || !this.meta) throw new Error('개인 폴더가 잠겨 있습니다')
    return this.key
  }

  private static validatePin(pin: string): void {
    if (typeof pin !== 'string' || pin.length < 4) throw new Error('PIN 은 4자 이상이어야 합니다')
  }

  async setup(pin: string): Promise<VaultState> {
    Vault.validatePin(pin)
    if (await this.loadMeta()) throw new Error('이미 개인 폴더가 설정되어 있습니다')
    const master = crypto.randomBytes(32)
    const salt = crypto.randomBytes(16)
    const kek = await scrypt(pin, salt)
    const wrapIv = crypto.randomBytes(12)
    const c = crypto.createCipheriv('aes-256-gcm', kek, wrapIv)
    const wrapped = Buffer.concat([c.update(master), c.final()])
    this.meta = {
      version: 1,
      salt: salt.toString('base64'),
      wrapIv: wrapIv.toString('base64'),
      wrappedKey: wrapped.toString('base64'),
      wrapTag: c.getAuthTag().toString('base64'),
      items: []
    }
    await this.saveMeta()
    this.key = master
    return this.state()
  }

  async unlock(pin: string): Promise<VaultState> {
    const meta = await this.loadMeta()
    if (!meta) throw new Error('개인 폴더가 아직 설정되지 않았습니다')
    const kek = await scrypt(pin, Buffer.from(meta.salt, 'base64'))
    try {
      const d = crypto.createDecipheriv('aes-256-gcm', kek, Buffer.from(meta.wrapIv, 'base64'))
      d.setAuthTag(Buffer.from(meta.wrapTag, 'base64'))
      this.key = Buffer.concat([d.update(Buffer.from(meta.wrappedKey, 'base64')), d.final()])
    } catch {
      this.key = null
      throw new Error('PIN 이 올바르지 않습니다')
    }
    return this.state()
  }

  async lock(): Promise<VaultState> {
    this.key = null
    await rmrf(this.tempDir())
    return this.state()
  }

  async changePin(oldPin: string, newPin: string): Promise<void> {
    Vault.validatePin(newPin)
    await this.unlock(oldPin)
    const master = this.requireKey()
    const salt = crypto.randomBytes(16)
    const kek = await scrypt(newPin, salt)
    const wrapIv = crypto.randomBytes(12)
    const c = crypto.createCipheriv('aes-256-gcm', kek, wrapIv)
    const wrapped = Buffer.concat([c.update(master), c.final()])
    this.meta = {
      ...this.meta!,
      salt: salt.toString('base64'),
      wrapIv: wrapIv.toString('base64'),
      wrappedKey: wrapped.toString('base64'),
      wrapTag: c.getAuthTag().toString('base64')
    }
    await this.saveMeta()
  }

  private encPath(id: string): string {
    return path.join(this.getDir(), `${id}.enc`)
  }

  async add(paths: string[]): Promise<VaultState> {
    const key = this.requireKey()
    await ensureDir(this.getDir())
    for (const src of paths) {
      const st = await fs.stat(src)
      if (!st.isFile()) continue
      const id = newId()
      const dest = this.encPath(id)
      await this.encryptFile(src, dest, key)
      this.meta!.items.push({
        id,
        name: path.basename(src),
        size: st.size,
        addedAt: Date.now(),
        ext: path.extname(src).slice(1).toLowerCase()
      })
      await this.saveMeta()
      await fs.rm(src, { force: true }).catch(() => undefined)
    }
    return this.state()
  }

  async remove(id: string): Promise<VaultState> {
    this.requireKey()
    await fs.rm(this.encPath(id), { force: true }).catch(() => undefined)
    this.meta!.items = this.meta!.items.filter((i) => i.id !== id)
    await this.saveMeta()
    await fs.rm(this.tempPathFor(id), { force: true }).catch(() => undefined)
    return this.state()
  }

  private tempPathFor(id: string): string {
    const item = this.meta?.items.find((i) => i.id === id)
    return path.join(this.tempDir(), `${id}${item?.ext ? `.${item.ext}` : ''}`)
  }

  /** 재생용 임시 복호화 파일 경로를 돌려준다. 잠그면 삭제된다. */
  async open(id: string): Promise<string> {
    const key = this.requireKey()
    const item = this.meta!.items.find((i) => i.id === id)
    if (!item) throw new Error('항목을 찾을 수 없습니다')
    const dest = this.tempPathFor(id)
    if (existsSync(dest) && (await fs.stat(dest)).size === item.size) return dest
    await ensureDir(this.tempDir())
    await this.decryptFile(this.encPath(id), dest, key)
    return dest
  }

  async export(id: string, destDir: string): Promise<string> {
    const key = this.requireKey()
    const item = this.meta!.items.find((i) => i.id === id)
    if (!item) throw new Error('항목을 찾을 수 없습니다')
    await ensureDir(destDir)
    const base = sanitizeFilename(item.ext ? item.name.slice(0, -(item.ext.length + 1)) : item.name)
    const dest = uniquePath(destDir, base, item.ext)
    await this.decryptFile(this.encPath(id), dest, key)
    return dest
  }

  private async encryptFile(src: string, dest: string, key: Buffer): Promise<void> {
    const iv = crypto.randomBytes(12)
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
    await fs.writeFile(dest, Buffer.concat([MAGIC, iv]))
    try {
      await pipeline(createReadStream(src), cipher, createWriteStream(dest, { flags: 'a' }))
      await fs.appendFile(dest, cipher.getAuthTag())
    } catch (e) {
      await fs.rm(dest, { force: true }).catch(() => undefined)
      throw e
    }
  }

  private async decryptFile(src: string, dest: string, key: Buffer): Promise<void> {
    const size = (await fs.stat(src)).size
    if (size < HEADER_LEN + TAG_LEN) throw new Error('손상된 파일입니다')
    const fh = await fs.open(src, 'r')
    let iv: Buffer
    let tag: Buffer
    try {
      const header = Buffer.alloc(HEADER_LEN)
      await fh.read(header, 0, HEADER_LEN, 0)
      if (!header.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('개인 폴더 파일 형식이 아닙니다')
      iv = header.subarray(MAGIC.length)
      tag = Buffer.alloc(TAG_LEN)
      await fh.read(tag, 0, TAG_LEN, size - TAG_LEN)
    } finally {
      await fh.close()
    }
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAuthTag(tag)
    const tmp = `${dest}.tmp`
    try {
      await pipeline(createReadStream(src, { start: HEADER_LEN, end: size - TAG_LEN - 1 }), decipher, createWriteStream(tmp))
      await fs.rename(tmp, dest)
    } catch (e) {
      await fs.rm(tmp, { force: true }).catch(() => undefined)
      throw new Error(`복호화 실패: ${e instanceof Error ? e.message : e}`)
    }
  }
}
