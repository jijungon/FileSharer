import { Page, test as base } from '@playwright/test'

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

// e2e 로그인 계정. **지금까지 모든 테스트가 관리자(ADMIN)로만 돌았다** — 그래서
// "관리자에게만 보이도록" 걸어둔 조건이 일반 사용자를 막고 있어도 아무도 몰랐다(실제 사고).
// MEMBER 로도 훑어서 그 틈을 막는다.
export const ADMIN = { email: 'e2e@test.local', password: 'e2e-password-123' }
export const MEMBER = { email: 'member@test.local', password: 'member-pass-123' }

/** 로그인 폼을 채워 /files 까지 간다. */
export async function loginAs(page: Page, who: { email: string; password: string }) {
  await page.goto('/login')
  await page.getByRole('button', { name: /로컬 계정으로 로그인/ }).click()
  await page.getByPlaceholder('이메일').fill(who.email)
  await page.getByPlaceholder('비밀번호').fill(who.password)
  await page.getByRole('button', { name: '로컬 계정으로 로그인' }).click()
  await page.waitForURL(/\/files/)
}

/** pageerror + console.error 를 모은다(아래 게이트와 memberPage 가 같이 쓴다). */
function collectErrors(page: Page, errors: string[]) {
  const record = (text: string) => {
    if (!ALLOW.some((re) => re.test(text))) errors.push(text)
  }
  page.on('pageerror', (e) => record(`[pageerror] ${e.message}`))
  page.on('console', (m) => {
    if (m.type() === 'error') record(`[console.error] ${m.text()}`)
  })
}

export const test = base.extend<{
  _reset: void
  _noConsoleErrors: void
  memberPage: Page
}>({
  _reset: [
    async ({ request }, use) => {
      await request.post('/api/test/reset').catch(() => {})
      await use()
    },
    { auto: true },
  ],
  // 일반 사용자(member)로 로그인된 별도 창. 관리자 세션과 섞이지 않게 컨텍스트를 따로 연다.
  memberPage: async ({ browser, request }, use, testInfo) => {
    // 계정 보장 — 관리자로 만든다. 이미 있으면 4xx 라 그냥 넘어간다(리셋이 사용자를 안 지운다).
    await request.post('/api/auth/login', { data: ADMIN }).catch(() => {})
    await request
      .post('/api/users', {  // 관리 라우터 prefix 는 /api (관례와 달리 /api/admin 이 아니다)
        data: { email: MEMBER.email, password: MEMBER.password, role: 'member' },
      })
      .catch(() => {})

    const context = await browser.newContext()
    const page = await context.newPage()
    const errors: string[] = []
    collectErrors(page, errors)
    await loginAs(page, MEMBER)

    await use(page)

    await context.close()
    if (testInfo.status === testInfo.expectedStatus && errors.length > 0) {
      throw new Error(`일반 사용자 화면에서 오류 ${errors.length}건:\n${errors.join('\n')}`)
    }
  },
  _noConsoleErrors: [
    async ({ page }, use, testInfo) => {
      const errors: string[] = []
      collectErrors(page, errors)
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
