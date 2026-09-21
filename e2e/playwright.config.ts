import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  retries: 1,
  // 단일 워커(직렬). 모든 테스트가 같은 백엔드·같은 e2e 사용자·같은 개인공간을 공유하는데,
  // 트리 전용 개편 이후 사이드바 트리(전체 파일)와 인라인 '최근'(MAX 5)이 전역 상태가 되어
  // 병렬 실행 시 서로의 목록을 밀어내 플레이크가 난다. 직렬로 돌려 상태를 결정적으로 만든다.
  workers: 1,
  use: {
    baseURL: process.env.BASE_URL ?? 'http://localhost:8484',
    trace: 'retain-on-failure',
  },
})
