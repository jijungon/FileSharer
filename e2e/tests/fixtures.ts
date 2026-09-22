import { test as base } from '@playwright/test'

// 각 테스트 '전에' 콘텐츠 데이터를 초기화해 스펙/테스트 간 상태 누수를 없앤다.
// 백엔드는 ENABLE_TEST_RESET일 때만 /api/test/reset 을 노출한다(없으면 4xx로 조용히 무시 →
// 격리 없이도 테스트는 그대로 돈다). 모든 spec은 '@playwright/test' 대신 이 파일에서 import 한다.
export const test = base.extend<{ _reset: void }>({
  _reset: [
    async ({ request }, use) => {
      await request.post('/api/test/reset').catch(() => {})
      await use()
    },
    { auto: true },
  ],
})

export { expect, request } from '@playwright/test'
