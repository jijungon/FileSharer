import { Page, request as apiRequest, test as base } from '@playwright/test'

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
  // HTML 미리보기(샌드박스 iframe)가 **스크립트를 막았다는 브라우저의 보고**다.
  // 앱 오류가 아니라 보안 장치가 작동한 증거라 통과시킨다 — 오히려 이게 안 나오면
  // sandbox 가 풀린 것이다(그건 share-guard.spec 이 따로 단언한다).
  /Blocked script execution in 'about:srcdoc'/i,
]

// e2e 로그인 계정. **지금까지 모든 테스트가 관리자(ADMIN)로만 돌았다** — 그래서
// "관리자에게만 보이도록" 걸어둔 조건이 일반 사용자를 막고 있어도 아무도 몰랐다(실제 사고).
// MEMBER 로도 훑어서 그 틈을 막는다.
export const ADMIN = { email: 'e2e@test.local', password: 'e2e-password-123' }
export const MEMBER = { email: 'member@test.local', password: 'member-pass-123' }

// ── 워커별 계정 ──
// 병렬로 돌리려면 워커끼리 서로의 파일을 안 봐야 한다. 계정을 나누면 **개인 공간이
// 자연히 나뉜다** — 로그인 후 기본 활성 공간이 개인 공간이고(spaces[0]), 업로드도 거기로
// 간다. 리셋도 그 계정 범위로만 돈다(`POST /api/test/reset?email=...`).
//
// Playwright 가 워커 프로세스마다 TEST_PARALLEL_INDEX 를 넣어준다. 그래서 **모듈 상수**로
// 만들 수 있고, 스펙은 기존 로그인 헬퍼를 그대로 두고 상수만 이걸로 바꾸면 된다.
//
// 워커 0 은 부트스트랩 관리자를 그대로 쓴다(계정을 새로 안 만들어도 된다).
// 역할은 admin — 기존 스펙 다수가 관리 기능을 쓴다(멤버 시점은 memberPage 가 따로 본다).
const WORKER_INDEX = Number(process.env.TEST_PARALLEL_INDEX ?? 0)

// 이 워커 프로세스에서 만드는 이름에 붙일 꼬리표.
//
// 테스트마다 데이터를 비우지 않으므로(위 주석 참고) **이름이 겹치면 안 된다.** 특히
// 재시도가 문제였다 — 실패한 시도가 남긴 파일과 재시도가 만든 파일이 같은 이름이면
// 행이 둘이 되어 로케이터가 엉킨다(실제로 trash.spec 이 10회 중 2회 흔들렸다).
// Playwright 는 실패 후 **새 워커 프로세스**로 재시도하므로 이 값도 새로 뽑힌다.
export const RUN_TAG = `${Date.now().toString(36)}${WORKER_INDEX}`

export const ACCOUNT: { email: string; password: string } =
  WORKER_INDEX === 0
    ? ADMIN
    : { email: `e2e-w${WORKER_INDEX}@test.local`, password: ADMIN.password }

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

export const test = base.extend<
  { _noConsoleErrors: void; memberPage: Page },
  { _ensureAccount: void }
>({
  // 워커당 한 번: 이 워커의 계정을 보장한다(워커 0 은 부트스트랩 관리자라 건너뛴다).
  //
  // **비우기는 여기서 하지 않는다.** 리셋은 6개 테이블을 일괄 삭제하는 큰 쓰기인데,
  // SQLite 는 쓰기가 하나뿐이라 여럿이 동시에 하면 `database is locked` 가 난다
  // (실제로 그렇게 500·로그인 튕김이 났다). 비우기는 globalSetup 이 실행 시작에 한 번만 한다.
  //
  // 그래서 한 워커 안에서는 데이터가 쌓이는데, 괜찮다 — 스펙들이 이름을 타임스탬프로
  // 고유화하고, 개수를 세는 단언도 전부 '그 화면/그 문서' 범위다(전역 개수를 세지 않는다).
  _ensureAccount: [
    async ({}, use, workerInfo) => {
      const api = await apiRequest.newContext({ baseURL: workerInfo.project.use.baseURL })
      if (ACCOUNT.email !== ADMIN.email) {
        // 이미 있으면 4xx 라 그냥 넘어간다(리셋은 사용자를 지우지 않는다).
        await api.post('/api/auth/login', { data: ADMIN }).catch(() => {})
        await api.post('/api/users', { data: { ...ACCOUNT, role: 'admin' } }).catch(() => {})
      }
      await api.dispose()
      // 여기서도, 테스트마다도 비우지 않는다. 비우기는 globalSetup 이 실행 시작에 한 번만 한다.
      //
      // 테스트마다 비워 봤는데 **더 나빴다**(10회 중 6회 흔들림). BEGIN IMMEDIATE 로 모든
      // 트랜잭션이 쓰기 잠금을 미리 잡으므로, 매번 큰 삭제를 끼우면 워커들이 줄줄이 기다린다.
      // 락 에러는 안 나지만 느려져서 단언이 시간 초과된다.
      //
      // 대신 **테스트가 만드는 이름을 고유하게** 한다(타임스탬프). 그러면 서로도, 재시도끼리도
      // 부딪히지 않는다.
      await use()
    },
    { scope: 'worker', auto: true },
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
