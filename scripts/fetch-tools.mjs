// 배포 패키지에 동봉할 yt-dlp / ffmpeg 를 resources/bin 에 내려받는다.
// 사용법: node scripts/fetch-tools.mjs [--platform win32|darwin|linux]
import { createWriteStream, existsSync } from 'node:fs'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const binDir = path.join(root, 'resources', 'bin')
const argPlatform = process.argv.indexOf('--platform')
const platform = argPlatform >= 0 ? process.argv[argPlatform + 1] : process.platform
const EXE = platform === 'win32' ? '.exe' : ''

const specs = [
  {
    name: 'yt-dlp',
    url: `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${platform === 'win32' ? 'yt-dlp.exe' : platform === 'darwin' ? 'yt-dlp_macos' : 'yt-dlp'}`,
    kind: 'binary',
    pick: ['yt-dlp' + EXE]
  },
  platform === 'win32'
    ? {
        name: 'ffmpeg',
        url: 'https://github.com/BtbN/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-win64-gpl.zip',
        kind: 'archive',
        pick: ['ffmpeg.exe', 'ffprobe.exe']
      }
    : platform === 'darwin'
      ? { name: 'ffmpeg', url: 'https://evermeet.cx/ffmpeg/getrelease/zip', kind: 'archive', pick: ['ffmpeg'] }
      : {
          name: 'ffmpeg',
          url: 'https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz',
          kind: 'archive',
          pick: ['ffmpeg', 'ffprobe']
        }
]

async function download(url, dest) {
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} for ${url}`)
  const total = Number(res.headers.get('content-length')) || 0
  let done = 0
  let lastPct = -1
  const out = createWriteStream(dest)
  for await (const chunk of res.body) {
    done += chunk.length
    if (!out.write(chunk)) await new Promise((r) => out.once('drain', r))
    if (total) {
      const pct = Math.floor((done / total) * 100)
      if (pct !== lastPct && pct % 10 === 0) {
        lastPct = pct
        process.stdout.write(`\r  ${pct}%`)
      }
    }
  }
  await new Promise((resolve, reject) => {
    out.end(resolve)
    out.on('error', reject)
  })
  process.stdout.write('\n')
}

function tar(archive, dest) {
  return new Promise((resolve, reject) => {
    const child = spawn('tar', ['-xf', archive, '-C', dest], { stdio: 'inherit' })
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`tar exit ${code}`))))
  })
}

async function findFile(dir, name) {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  for (const e of entries) if (e.isFile() && e.name === name) return path.join(dir, e.name)
  for (const e of entries) {
    if (e.isDirectory()) {
      const r = await findFile(path.join(dir, e.name), name)
      if (r) return r
    }
  }
  return null
}

await fs.mkdir(binDir, { recursive: true })
for (const spec of specs) {
  const already = spec.pick.every((p) => existsSync(path.join(binDir, p)))
  if (already && !process.argv.includes('--force')) {
    console.log(`${spec.name}: 이미 존재합니다 (--force 로 다시 받기)`)
    continue
  }
  console.log(`${spec.name}: ${spec.url}`)
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'vdl-fetch-'))
  try {
    if (spec.kind === 'binary') {
      const dest = path.join(binDir, spec.pick[0])
      await download(spec.url, dest)
      if (platform !== 'win32') await fs.chmod(dest, 0o755)
    } else {
      const archive = path.join(tmp, 'archive' + (spec.url.endsWith('.tar.xz') ? '.tar.xz' : '.zip'))
      await download(spec.url, archive)
      const x = path.join(tmp, 'x')
      await fs.mkdir(x)
      await tar(archive, x)
      for (const want of spec.pick) {
        const found = await findFile(x, want)
        if (!found) throw new Error(`${want} 을(를) 압축에서 찾지 못했습니다`)
        await fs.copyFile(found, path.join(binDir, want))
        if (platform !== 'win32') await fs.chmod(path.join(binDir, want), 0o755)
      }
    }
    console.log(`${spec.name}: 완료 -> ${binDir}`)
  } finally {
    await fs.rm(tmp, { recursive: true, force: true })
  }
}
