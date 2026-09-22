import { test as base } from '@playwright/test'

// 각 테스트 '전에' 콘텐츠 데이터를 초기화해 스펙/테스트 간 상태 누수를 없앤다.
// 백엔드는 ENABLE_TEST_RESET일 때만 /api/test/reset 을 노출한다(없으면 4xx로 조용히 무시 →
// 격리 없이도 테스트는 그대로 돈다). 모든 spec은 '@playwright/test' 대신 이 파일에서 import 한다.
//
// 또한 각 테스트에서 '처리되지 않은 런타임 오류(pageerror) + console.error'를 수집해,
// 하나라도 있으면 테스트를 실패시킨다. "테스트는 통과하는데 실사용에서 콘솔 에러가 난다"를
// CI에서 자동으로 잡기 위한 게이트 — 구조를 바꿔도 조용한 오류가 그냥 통과하지 못한다.
// (네트워크/리소스 잡음은 ALLOW로 제외한다.)
const ALLOW = [
  /favicon/i,
  /cdn-cgi/i, // Cloudflare RUM·challenge 등 인프라 스크립트
  /challenge-platform/i,
  /Failed to load resource/i, // 리소스 404 등(앱 로직 에러 아님)
  /net::ERR_/i,
]

export const test = base.extend<{ _reset: void; _noConsoleErrors: void }>({
  _reset: [
    async ({ request }, use) => {
      await request.post('/api/test/reset').catch(() => {})
      await use()
    },
    { auto: true },
  ],
  _noConsoleErrors: [
    async ({ page }, use, testInfo) => {
      const errors: string[] = []
      const record = (text: string) => {
        if (!ALLOW.some((re) => re.test(text))) errors.push(text)
      }
      page.on('pageerror', (e) => record(`[pageerror] ${e.message}`))
      page.on('console', (m) => {
        if (m.type() === 'error') record(`[console.error] ${m.text()}`)
      })
      await use()
      // 이미 실패한 테스트는 이유가 명확하니 콘솔 게이트를 덧씌우지 않는다.
      if (testInfo.status === testInfo.expectedStatus && errors.length > 0) {
        throw new Error(`런타임/콘솔 에러 ${errors.length}건 감지:\n${errors.join('\n')}`)
      }
    },
    { auto: true },
  ],
})

export { expect, request } from '@playwright/test'
