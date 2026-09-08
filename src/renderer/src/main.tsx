import React from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { AppProvider } from './state/AppContext'
import './styles.css'

if (import.meta.env.DEV) {
  // React 개발 빌드는 props 가 바뀐 컴포넌트를 렌더할 때마다 performance.measure() 로 User Timing 항목을 남기고,
  // Chromium 은 이 항목을 지우기 전까지 모두 보관한다. 다운로드 진행률처럼 갱신이 잦으면 초당 수천 개가 쌓여
  // 렌더러 메모리가 끝없이 늘다가 죽으므로(검은 화면) 주기적으로 비운다. 프로덕션 빌드에는 이 항목이 없다.
  window.setInterval(() => {
    performance.clearMeasures()
    performance.clearMarks()
  }, 2000)
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AppProvider>
      <App />
    </AppProvider>
  </React.StrictMode>
)
