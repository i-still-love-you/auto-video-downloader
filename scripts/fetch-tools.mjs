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

// 압축 해제에 쓸 tar. Windows 는 내장 bsdtar(System32\tar.exe)가 zip 도 풀 수 있으므로 그것을 우선 쓴다.
// PATH 에 Git 의 GNU tar 가 먼저 잡히면 zip 을 읽지 못하고 "C:\..." 경로를 원격 호스트로 해석해 실패한다.
function tarCommand() {
  if (process.platform === 'win32') {
    const sys = path.join(process.env.SystemRoot || 'C:\Windows', 'System32', 'tar.exe')
    if (existsSync(sys)) return sys
  }
  return 'tar'
}

// 어느 tar 든 안전하도록 아카이브가 있는 폴더를 작업 디렉터리로 잡고 상대 경로만 넘긴다
function tar(archive, dest) {
  const cwd = path.dirname(archive)
  return new Promise((resolve, reject) => {
    const child = spawn(tarCommand(), ['-xf', path.basename(archive), '-C', path.relative(cwd, dest) || '.'], { cwd, stdio: 'inherit' })
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
