import { expect, test } from './fixtures'

test('health endpoint responds', async ({ request }) => {
  const res = await request.get('/api/health')
  expect(res.ok()).toBeTruthy()
  expect(await res.json()).toMatchObject({ ok: true })
})

test('login page renders', async ({ page }) => {
  await page.goto('/login')
  await expect(page.getByRole('heading', { name: 'FileSharer' })).toBeVisible()
  // 구글 버튼은 GOOGLE_CLIENT_ID 설정 시에만 노출 — 항상 있는 로컬 로그인 토글로 검증
  await expect(page.getByRole('button', { name: /로컬 계정으로 로그인/ })).toBeVisible()
})

test('상단 버전 배지는 서버가 보고하는 값을 쓴다', async ({ page, request }) => {
  // 번들 안에 박힌 문자열이면, 프런트가 안 바뀐 배포에서 파일명이 그대로라
  // CDN이 옛 바이트를 계속 내주며 거짓 버전을 보여준다(실제로 겪었다).
  const health = await request.get('/api/health').then((r) => r.json())
  expect(health.version).toBeTruthy()
  // 빌드 번호는 main 커밋 수 — 큰 쪽이 최신이어야 한다(PR 번호는 그 보장이 없다)
  expect(health).toHaveProperty('build')
  expect(health).toHaveProperty('built_at')

  await page.goto('/login')
  await page.getByRole('button', { name: /로컬 계정으로 로그인/ }).click()
  await page.getByPlaceholder('이메일').fill('e2e@test.local')
  await page.getByPlaceholder('비밀번호').fill('e2e-password-123')
  await page.getByRole('button', { name: '로컬 계정으로 로그인' }).click()
  await expect(page).toHaveURL(/\/files/)

  await expect(page.locator('.logo .app-version')).toHaveText(health.version)
})
