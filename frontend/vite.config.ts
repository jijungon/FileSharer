/// <reference types="vitest/config" />
// node 내장 모듈 — 빌드(Node)에서만 실행되며, @types/node를 의존성에 추가하지 않으려고 타입만 무시한다.
// @ts-expect-error: 'node:child_process' 타입 선언 없음(런타임엔 정상 존재)
import { execSync } from 'node:child_process'

import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

declare const process: { env: Record<string, string | undefined> }

// 빌드 시점의 버전 라벨: 태그가 있으면 vX.Y.Z, 없으면 short SHA (커밋 안 된 변경은 -dirty).
// prod 화면 구석에 표시해 "지금 어떤 버전이 배포됐는지" 한눈에 확인한다.
const appVersion = (() => {
  if (process.env.APP_VERSION) return process.env.APP_VERSION
  try {
    return execSync('git describe --tags --always --dirty', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim()
  } catch {
    return 'dev'
  }
})()

// https://vite.dev/config/
export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
  },
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:8642',
      // 공유 하위 액션(/s/<token>/meta|raw|download|tar|get)만 백엔드로 프록시.
      // 맨 앞 페이지 /s/<token> 은 SPA(index.html)가 렌더하도록 프록시하지 않는다.
      '^/s/[^/]+/': 'http://localhost:8642',
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
  },
})
