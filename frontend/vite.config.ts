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
      '/s': 'http://localhost:8642',
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
  },
})
