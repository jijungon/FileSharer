import { expect, test } from '@playwright/test'

test('health endpoint responds', async ({ request }) => {
  const res = await request.get('/api/health')
  expect(res.ok()).toBeTruthy()
  expect(await res.json()).toMatchObject({ ok: true })
})

test('login page renders', async ({ page }) => {
  await page.goto('/login')
  await expect(page.getByRole('heading', { name: 'FileSharer' })).toBeVisible()
  await expect(page.getByRole('button', { name: /Google로 로그인/ })).toBeVisible()
})
