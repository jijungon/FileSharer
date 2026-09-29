import { defineConfig } from '@playwright/test'

// 공유 자원을 건드리는 스펙 — 워커를 나눠도 격리되지 않는 것들.
//   · 전체 공간(org)·팀 — 시스템에 하나뿐이다
//   · 사용자 목록·역할 — 전역이다
//   · member@test.local — 워커들이 같은 계정을 쓴다
// 나머지는 각자 **자기 개인 공간**에서만 논다(워커마다 계정이 다르므로 자연히 격리).
const SHARED = [
  '**/cross-space.spec.ts',
  '**/team.spec.ts',
  '**/admin.spec.ts',
  '**/member-view.spec.ts',
]

export default defineConfig({
  testDir: './tests',
  // 실행 시작에 한 번 전체를 비운다 — 테스트별 리셋은 계정 범위라 org/팀 공간은 아무도 안 치운다.
  globalSetup: './global-setup.ts',
  timeout: 30_000,
  // 병렬로 돌리면 백엔드(한 프로세스·SQLite)에서 쓰기가 줄을 선다. 기본 5초는 그때 빠듯해
  // '아직 안 나타났다'로 오판한다 — 느린 것이지 틀린 게 아니다. 여유를 준다.
  expect: { timeout: 10_000 },
  retries: 1,
  // 워커마다 계정이 다르고(tests/fixtures.ts ACCOUNT), 리셋도 그 계정 범위로만 돈다
  // (POST /api/test/reset?email=...). 그래서 개인 공간만 쓰는 테스트는 병렬로 돌아도
  // 서로를 안 건드린다. 예전엔 리셋이 DB 전체를 비워서 워커를 하나만 쓸 수 있었다.
  workers: Number(process.env.PW_WORKERS ?? 4),
  fullyParallel: true,
  use: {
    baseURL: process.env.BASE_URL ?? 'http://localhost:8484',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      // 자기 공간에서만 노는 것들 — 마음껏 병렬.
      name: 'solo',
      testIgnore: SHARED,
    },
    {
      // 공유 자원을 쓰는 것들 — **한 워커로** 돌려야 한다. 넷이 동시에 팀을 만들고 지우면
      // 서로의 목록을 밟는다(실제로 team.spec 이 그렇게 깨졌다).
      //
      // Playwright 는 프로젝트별 워커 수를 못 정한다(workers 는 전역 설정이다). 그래서
      // 호출을 나눈다 — `npm test` 가 solo 를 병렬로 돌린 뒤 이걸 `--workers=1` 로 돌린다.
      // 그냥 `npx playwright test` 로 둘을 한 번에 돌리면 이 그룹이 흔들릴 수 있다.
      name: 'shared',
      testMatch: SHARED,
      fullyParallel: false,
    },
  ],
})
