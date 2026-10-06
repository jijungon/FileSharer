import { ACCOUNT, expect, test } from './fixtures'

const EMAIL = ACCOUNT.email
const PASSWORD = ACCOUNT.password

async function login(page) {
  await page.goto('/login')
  await page.getByRole('button', { name: /로컬 계정으로 로그인/ }).click()
  await page.getByPlaceholder('이메일').fill(EMAIL)
  await page.getByPlaceholder('비밀번호').fill(PASSWORD)
  await page.getByRole('button', { name: '로컬 계정으로 로그인' }).click()
  await expect(page).toHaveURL(/\/files/)
}

/** 터미널이 하는 일 — 코드 한 쌍을 받아온다(인증 없이). */
async function startDeviceLogin(request, clientName = 'joji-macbook') {
  const res = await request.post('/api/device/code', { data: { client_name: clientName } })
  expect(res.status()).toBe(201)
  return res.json()
}

test('CLI 로그인: 터미널이 코드를 받고 → 브라우저에서 승인 → 터미널이 토큰을 받아 바로 쓴다', async ({
  page,
}) => {
  await login(page)
  const started = await startDeviceLogin(page.request)

  // 아직 아무도 승인 안 했다
  const pending = await page.request.post('/api/device/token', {
    data: { device_code: started.device_code },
  })
  expect((await pending.json()).detail.error).toBe('authorization_pending')

  // 터미널이 띄운 주소로 그대로 들어간다(verification_uri_complete)
  await page.goto(`/device?code=${started.user_code}`)

  // **무엇을 승인하는지가 보여야 한다** — 이 방식의 약점이 "이 코드 좀 넣어주세요" 피싱이다.
  // 기기 이름은 요약문에도 나오므로 사실 목록(.device-facts)을 집는다 — 판단의 근거는 거기다.
  const facts = page.locator('.device-facts')
  // **누구 자격인지가 맨 위다.** 토큰은 지금 이 브라우저 세션의 계정을 물려받는다 —
  // 공용 브라우저에 남의 계정으로 로그인돼 있으면 그 자격을 모른 채 내주게 된다.
  await expect(facts.locator('dt').first()).toHaveText('누구 자격으로')
  await expect(facts.locator('dd').first()).toHaveText(EMAIL)
  await expect(facts).toContainText('joji-macbook')
  await expect(facts).toContainText('요청 IP')
  await expect(facts).toContainText('요청 시각')
  // 시각은 '방금' 이어야 한다. 서버의 naive-UTC 를 로컬로 읽으면 '9시간 전'이 나오는데,
  // 하필 사람이 '내가 방금 한 게 맞나' 를 가늠하는 단서라 틀리면 안 된다.
  await expect(facts.locator('dd').last()).toHaveText(/방금|초 전/)

  // 요약문도 '누가·누구 자격으로·어디까지·얼마나' 를 한 줄로 말한다
  await expect(page.locator('.device-summary')).toContainText(EMAIL)

  await page.getByRole('button', { name: '허용', exact: true }).click()
  await expect(page.getByText('허용했습니다')).toBeVisible()

  // 터미널이 토큰을 받아간다. **서버가 준 interval 을 지킨다** — 더 빨리 물으면
  // slow_down 이 온다(실제 CLI 도 이 간격을 지켜야 한다). 여기서 기다리는 건
  // 테스트를 늘리려는 게 아니라 클라이언트가 해야 할 일을 그대로 하는 것이다.
  await page.waitForTimeout(started.interval * 1000 + 200)
  const got = await page.request.post('/api/device/token', {
    data: { device_code: started.device_code },
  })
  expect(got.status()).toBe(200)
  const token = (await got.json()).token
  expect(token.startsWith('fsk_')).toBeTruthy()

  // 받은 토큰이 실제로 동작해야 의미가 있다 — 쿠키 없는 맥락에서 둘러보기
  const anon = await page.context().browser()!.newContext()
  const listed = await anon.request.get('/api/spaces', {
    headers: { Authorization: `Bearer ${token}` },
  })
  expect(listed.status()).toBe(200)
  expect((await listed.json()).length).toBeGreaterThan(0)
  await anon.close()
})

test('CLI 로그인: 간격을 안 지키고 연달아 물으면 slow_down', async ({ page }) => {
  // 인증 없이 열린 엔드포인트라 서버를 지켜야 한다. 한 번 고장 났던 곳이기도 하다 —
  // 폴링의 정상 응답이 에러(authorization_pending)인데 이 앱은 성공 응답에서만
  // 커밋하므로, 방금 찍은 폴링 시각이 롤백돼 간격 제한이 통째로 죽어 있었다.
  await login(page)
  const started = await startDeviceLogin(page.request, 'impatient')

  const first = await page.request.post('/api/device/token', {
    data: { device_code: started.device_code },
  })
  expect((await first.json()).detail.error).toBe('authorization_pending')

  const second = await page.request.post('/api/device/token', {
    data: { device_code: started.device_code },
  })
  expect((await second.json()).detail.error).toBe('slow_down')
})

test('CLI 로그인: 거부하면 터미널에 access_denied 가 간다', async ({ page }) => {
  await login(page)
  const started = await startDeviceLogin(page.request, 'ci-runner')

  await page.goto(`/device?code=${started.user_code}`)
  await page.getByRole('button', { name: '거부', exact: true }).click()
  await expect(page.getByText('거부했습니다')).toBeVisible()

  const res = await page.request.post('/api/device/token', {
    data: { device_code: started.device_code },
  })
  expect((await res.json()).detail.error).toBe('access_denied')
})

test('CLI 로그인: 로그인 안 한 채로 들어가면 로그인 뒤 그 코드로 돌아온다', async ({ browser }) => {
  // 코드는 미인증으로 받는다 — 터미널이 하는 일이다
  const anon = await browser.newContext()
  const page = await anon.newPage()
  const started = await startDeviceLogin(page.request, 'new-laptop')

  await page.goto(`/device?code=${started.user_code}`)
  // 로그인으로 보내되 **돌아올 곳을 들고 간다** — 안 그러면 코드를 잃고 처음부터 다시다
  await expect(page).toHaveURL(/\/login\?next=/)

  await page.getByRole('button', { name: /로컬 계정으로 로그인/ }).click()
  await page.getByPlaceholder('이메일').fill(EMAIL)
  await page.getByPlaceholder('비밀번호').fill(PASSWORD)
  await page.getByRole('button', { name: '로컬 계정으로 로그인' }).click()

  await expect(page).toHaveURL(new RegExp(`/device\\?code=${started.user_code}`))
  await expect(page.locator('.device-facts')).toContainText('new-laptop')
  await anon.close()
})

test('CLI 로그인: 틀린 코드는 조용히 넘어가지 않고 말을 해준다', async ({ page }) => {
  await login(page)
  await page.goto('/device')
  await page.getByLabel('터미널에 뜬 코드').fill('ZZZZ-ZZZZ')
  await page.getByRole('button', { name: '확인', exact: true }).click()
  await expect(page.locator('.device-error')).toBeVisible()
  await expect(page.getByRole('button', { name: '허용', exact: true })).toHaveCount(0)
})


test('CLI 로그인: 받은 토큰이 어느 계정 것인지 서버가 말해준다', async ({ page }) => {
  // 터미널의 `whoami` 가 이걸 쓴다. 기기 이름은 '어디서' 지 '누구' 가 아니다.
  await login(page)
  const made = await page.request.post('/api/tokens', { data: { label: 'bastion' } })
  const token = (await made.json()).token

  const anon = await page.context().browser()!.newContext()
  const who = await anon.request.get('/api/me', {
    headers: { Authorization: `Bearer ${token}` },
  })
  expect(who.status()).toBe(200)
  expect((await who.json()).email).toBe(EMAIL)
  await anon.close()
})
