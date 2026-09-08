import React, { useCallback, useEffect, useState } from 'react'
import type { PreferredQuality, ToolInstallProgress, ToolName, ToolStatus, UpdateInfo } from '@shared/types'
import { SEARCH_ENGINES } from '@shared/types'
import { useApp } from '../state/AppContext'
import { Icon } from '../components/Icon'
import { errorText, formatBytes } from '../lib/format'

const QUALITY: Array<{ v: PreferredQuality; label: string }> = [
  { v: 'ask', label: '매번 선택 (자동 시 최고 화질)' },
  { v: 'best', label: '최고 화질' },
  { v: '1080', label: '1080p 이하' },
  { v: '720', label: '720p 이하' },
  { v: '480', label: '480p 이하' },
  { v: 'worst', label: '최저 화질 (용량 절약)' }
]

export function SettingsPage({ active }: { active: boolean }): React.JSX.Element {
  const { settings, saveSettings, toast } = useApp()
  const [tools, setTools] = useState<ToolStatus[]>([])
  const [installing, setInstalling] = useState<Partial<Record<ToolName, ToolInstallProgress>>>({})
  const [version, setVersion] = useState('')
  const [update, setUpdate] = useState<UpdateInfo>({ status: 'idle' })
  const [toolPathDraft, setToolPathDraft] = useState<{ ytdlp: string; ffmpeg: string }>({ ytdlp: '', ffmpeg: '' })

  const refreshTools = useCallback(async (fresh = false) => setTools(await window.api.tools.status(fresh)), [])

  useEffect(() => {
    if (!active) return
    void refreshTools()
    void window.api.app.version().then(setVersion)
    void window.api.app.updateStatus().then(setUpdate)
  }, [active, refreshTools])

  useEffect(() => {
    if (settings) setToolPathDraft({ ytdlp: settings.toolPaths.ytdlp ?? '', ffmpeg: settings.toolPaths.ffmpeg ?? '' })
  }, [settings])

  useEffect(() => {
    const off = window.api.tools.onProgress((p) => setInstalling((prev) => ({ ...prev, [p.name]: p })))
    const offUpdate = window.api.app.onUpdate(setUpdate)
    return () => {
      off()
      offUpdate()
    }
  }, [])

  const install = async (name: ToolName): Promise<void> => {
    try {
      await window.api.tools.install(name)
      toast({ type: 'success', message: `${name === 'ytdlp' ? 'yt-dlp' : 'ffmpeg'} 설치가 완료되었습니다` })
    } catch (e) {
      toast({ type: 'error', message: errorText(e) })
    } finally {
      setInstalling((prev) => ({ ...prev, [name]: undefined }))
      await refreshTools(true)
    }
  }

  const chooseDir = async (key: 'downloadDir' | 'vaultDir'): Promise<void> => {
    const dir = await window.api.settings.chooseDir(settings?.[key])
    if (dir) await saveSettings({ [key]: dir })
  }

  const saveToolPaths = async (): Promise<void> => {
    await saveSettings({ toolPaths: { ytdlp: toolPathDraft.ytdlp.trim() || undefined, ffmpeg: toolPathDraft.ffmpeg.trim() || undefined } })
    await refreshTools(true)
    toast({ type: 'success', message: '도구 경로를 저장했습니다' })
  }

  if (!settings) return <div className="page-body">불러오는 중...</div>
  const s = settings

  return (
    <>
      <div className="page-header">
        <h2>설정</h2>
      </div>
      <div className="page-body">
        <section className="settings-section">
          <h3>다운로드</h3>
          <div className="field">
            <label className="field-label">저장 폴더</label>
            <div className="row">
              <input className="input" value={s.downloadDir} readOnly />
              <button className="btn" onClick={() => void chooseDir('downloadDir')}>
                변경
              </button>
              <button className="btn" onClick={() => void window.api.files.showInFolder(s.downloadDir)}>
                <Icon name="folder" size={14} />
              </button>
            </div>
          </div>
          <div className="row wrap" style={{ gap: 20 }}>
            <div className="field">
              <label className="field-label">동시 다운로드 수</label>
              <input className="input" type="number" min={1} max={10} value={s.maxConcurrent} onChange={(e) => void saveSettings({ maxConcurrent: Number(e.target.value) })} style={{ width: 100 }} />
            </div>
            <div className="field">
              <label className="field-label">파일당 연결 수 (멀티스레드)</label>
              <input className="input" type="number" min={1} max={32} value={s.connections} onChange={(e) => void saveSettings({ connections: Number(e.target.value) })} style={{ width: 100 }} />
            </div>
            <div className="field">
              <label className="field-label">기본 화질</label>
              <select className="select" value={s.preferredQuality} onChange={(e) => void saveSettings({ preferredQuality: e.target.value as PreferredQuality })}>
                {QUALITY.map((q) => (
                  <option key={q.v} value={q.v}>
                    {q.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label className="field-label">감지 최소 크기 (KB)</label>
              <input
                className="input"
                type="number"
                min={0}
                value={Math.round(s.detectMinSize / 1024)}
                onChange={(e) => void saveSettings({ detectMinSize: Number(e.target.value) * 1024 })}
                style={{ width: 120 }}
              />
              <span className="hint">이보다 작은 직접 파일은 광고/미리보기로 보고 무시합니다</span>
            </div>
          </div>
          <label className="checkbox">
            <input type="checkbox" checked={s.remuxToMp4} onChange={(e) => void saveSettings({ remuxToMp4: e.target.checked })} />
            병합 결과를 MP4 컨테이너로 저장 (ffmpeg 필요)
          </label>
          <label className="checkbox mt-8">
            <input type="checkbox" checked={s.interceptBrowserDownloads} onChange={(e) => void saveSettings({ interceptBrowserDownloads: e.target.checked })} />
            내장 브라우저의 파일 다운로드를 다운로드 관리자로 가로채기
          </label>
        </section>

        <section className="settings-section">
          <h3>브라우저</h3>
          <div className="row wrap" style={{ gap: 20 }}>
            <div className="field">
              <label className="field-label">기본 검색 엔진</label>
              <select className="select" value={s.searchEngineId} onChange={(e) => void saveSettings({ searchEngineId: e.target.value })}>
                {SEARCH_ENGINES.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="field grow">
              <label className="field-label">새 탭 홈페이지 (비우면 시작 페이지)</label>
              <input className="input" placeholder="https://" defaultValue={s.homeUrl} onBlur={(e) => e.target.value !== s.homeUrl && void saveSettings({ homeUrl: e.target.value.trim() })} />
            </div>
          </div>
        </section>

        <section className="settings-section">
          <h3>개인 폴더</h3>
          <div className="field">
            <label className="field-label">암호화 파일 저장 위치</label>
            <div className="row">
              <input className="input" value={s.vaultDir} readOnly />
              <button className="btn" onClick={() => void chooseDir('vaultDir')}>
                변경
              </button>
            </div>
            <span className="hint">위치를 바꾸면 기존 항목은 이전 폴더에 남습니다. 옮기려면 파일을 직접 이동해 주세요.</span>
          </div>
        </section>

        <section className="settings-section">
          <h3>도구 (yt-dlp / ffmpeg)</h3>
          {tools.map((t) => {
            const prog = installing[t.name]
            const label = t.name === 'ytdlp' ? 'yt-dlp' : 'ffmpeg'
            return (
              <div key={t.name} className="tool-row">
                <span className="name">{label}</span>
                <span className={`pill ${t.found ? 'ok' : 'no'}`}>{t.found ? '사용 가능' : '없음'}</span>
                <span className="info" title={t.path}>
                  {t.found ? `${t.version ?? ''} · ${t.source} · ${t.path}` : t.name === 'ytdlp' ? '동영상 사이트 페이지 주소 분석에 필요합니다' : 'HLS 병합과 MP4 변환에 필요합니다'}
                </span>
                {prog && prog.stage !== 'done' && prog.stage !== 'error' ? (
                  <span className="small muted">
                    {prog.stage === 'download' ? `다운로드 ${formatBytes(prog.downloaded)}${prog.total ? ` / ${formatBytes(prog.total)}` : ''}` : '압축 해제 중'}
                  </span>
                ) : (
                  <button className="btn sm" onClick={() => void install(t.name)}>
                    <Icon name="download" size={13} /> {t.found ? '최신 버전 받기' : '자동 설치'}
                  </button>
                )}
              </div>
            )
          })}
          <div className="field mt-16">
            <label className="field-label">경로 직접 지정 (선택)</label>
            <div className="row">
              <input className="input" placeholder="yt-dlp 실행 파일 경로" value={toolPathDraft.ytdlp} onChange={(e) => setToolPathDraft({ ...toolPathDraft, ytdlp: e.target.value })} />
              <input className="input" placeholder="ffmpeg 실행 파일 경로" value={toolPathDraft.ffmpeg} onChange={(e) => setToolPathDraft({ ...toolPathDraft, ffmpeg: e.target.value })} />
              <button className="btn" onClick={() => void saveToolPaths()}>
                저장
              </button>
              <button className="icon-btn" onClick={() => void refreshTools(true)} title="다시 검색">
                <Icon name="reload" />
              </button>
            </div>
            <span className="hint">비워 두면 앱 번들, 사용자 데이터 폴더, PATH 순서로 자동 검색합니다. 자동 설치는 사용자 데이터 폴더에 저장됩니다.</span>
          </div>
        </section>

        <section className="settings-section">
          <h3>업데이트</h3>
          <div className="row">
            <span>현재 버전 {version}</span>
            <span className="muted small grow">
              {update.status === 'checking' && '확인 중...'}
              {update.status === 'available' && `새 버전 ${update.version} 다운로드 중`}
              {update.status === 'not-available' && '최신 버전입니다'}
              {update.status === 'downloaded' && `버전 ${update.version} 설치 준비 완료`}
              {update.status === 'error' && `오류: ${update.message}`}
              {update.status === 'unsupported' && update.message}
            </span>
            {update.status === 'downloaded' ? (
              <button className="btn primary" onClick={() => void window.api.app.installUpdate()}>
                다시 시작하여 설치
              </button>
            ) : (
              <button className="btn" disabled={update.status === 'checking' || update.status === 'unsupported'} onClick={() => void window.api.app.checkUpdate().then(setUpdate)}>
                업데이트 확인
              </button>
            )}
          </div>
          <label className="checkbox mt-8">
            <input type="checkbox" checked={s.autoUpdate} onChange={(e) => void saveSettings({ autoUpdate: e.target.checked })} />
            시작할 때 자동으로 업데이트 확인
          </label>
        </section>

        <section className="settings-section">
          <h3>안내</h3>
          <p className="muted small" style={{ margin: 0, lineHeight: 1.6 }}>
            이 프로그램은 개인적 용도로 웹의 동영상을 저장하기 위한 도구입니다. 콘텐츠의 저작권과 각 사이트의 이용 약관을 준수해 주세요. DRM(Widevine, SAMPLE-AES 등)으로 보호된 콘텐츠는
            다운로드할 수 없으며, 지원하지 않습니다.
          </p>
        </section>
      </div>
    </>
  )
}
