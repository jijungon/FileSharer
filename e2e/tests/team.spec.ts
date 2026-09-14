import { expect, test } from '@playwright/test'

const EMAIL = 'e2e@test.local'
const PASSWORD = 'e2e-password-123'

async function loginAdmin(page) {
  await page.goto('/login')
  await page.getByRole('button', { name: /로컬 계정으로 로그인/ }).click()
  await page.getByPlaceholder('이메일').fill(EMAIL)
  await page.getByPlaceholder('비밀번호').fill(PASSWORD)
  await page.getByRole('button', { name: '로컬 계정으로 로그인' }).click()
  await expect(page).toHaveURL(/\/files/)
}

test('admin can create and delete a team', async ({ page }) => {
  await loginAdmin(page)
  await page.getByRole('button', { name: '관리' }).click()
  await page.getByRole('button', { name: '팀', exact: true }).click()

  // 고유 팀 이름 (반복 실행/공유 DB에서도 충돌 없게)
  const name = `E2E팀-${Date.now()}`
  await page.getByPlaceholder('팀 이름').fill(name)
  await page.getByRole('button', { name: '생성' }).click()

  // 팀 카드가 생겼다
  const card = page.locator('h3', { hasText: name })
  await expect(card).toBeVisible()

  // 삭제 (confirm 자동 수락) → 카드가 사라진다
  page.once('dialog', (d) => d.accept())
  await card.locator('..').getByRole('button', { name: '팀 삭제' }).click()
  await expect(page.locator('h3', { hasText: name })).toHaveCount(0)
})
