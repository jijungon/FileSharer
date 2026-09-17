/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

import pkg from './package.json'

declare const process: { env: Record<string, string | undefined> }

// 배포 버전 라벨 = 머지된 PR 번호("버전 == PR 번호" 규칙). prod 빌드에선 CI(ci.yml image 잡)가
// 머지 커밋의 (#NN)을 뽑아 APP_VERSION=v0.0.NN 로 주입한다(Dockerfile ARG→ENV 경유).
// APP_VERSION이 없을 때(로컬 dev·직접 푸시)만 package.json 버전으로 폴백.
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
