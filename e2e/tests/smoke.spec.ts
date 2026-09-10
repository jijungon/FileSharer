import { expect, test } from '@playwright/test'

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
