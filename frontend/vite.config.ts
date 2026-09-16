/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

import pkg from './package.json'

declare const process: { env: Record<string, string | undefined> }

// 배포 버전 라벨 = package.json 버전(semver). 릴리스마다 여기 버전을 올리면 화면 뱃지에 반영된다.
// (도커/CI에서 굳이 git이나 build-arg가 필요 없음 — 소스가 곧 버전.) 필요 시 APP_VERSION로 덮어쓰기.
const appVersion = process.env.APP_VERSION || `v${pkg.version}`

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
