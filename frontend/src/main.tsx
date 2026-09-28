import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import ErrorBoundary from './components/ErrorBoundary'
import { installGlobalErrorHandlers } from './lib/globalErrors'
import { initSentry } from './lib/sentry'
import './styles.css'

// 전역 미처리 오류(런타임·promise rejection)를 토스트+콘솔로 노출한다.
installGlobalErrorHandlers()

// 에러 추적은 서버가 준 DSN으로 켠다(번들에 박지 않는다 — 환경마다 재빌드가 필요해진다).
// 첫 페인트를 막지 않으려고 렌더와 **나란히** 진행한다. 그 사이(수십 ms)에 난 오류는
// 놓치지만, 그걸 잡으려고 모든 페이지 로드를 왕복 한 번만큼 늦추는 건 남는 장사가 아니다.
fetch('/api/health', { cache: 'no-store' })
  .then((res) => res.json())
  .then((config) => initSentry(config))
  .catch(() => {})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </ErrorBoundary>
  </StrictMode>,
)
