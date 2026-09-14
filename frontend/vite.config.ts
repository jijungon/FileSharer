/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
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
