import { expect, test } from '@playwright/test'

const EMAIL = 'e2e@test.local'
const PASSWORD = 'e2e-password-123'

test('local login → browse → create folder → upload file', async ({ page }) => {
  await page.goto('/login')
  await page.getByRole('button', { name: /로컬 계정으로 로그인/ }).click()
  await page.getByPlaceholder('이메일').fill(EMAIL)
  await page.getByPlaceholder('비밀번호').fill(PASSWORD)
  await page.getByRole('button', { name: '로컬 계정으로 로그인' }).click()

  await expect(page).toHaveURL(/\/files/)
  await expect(page.getByRole('button', { name: /내 공간/ })).toBeVisible()

  page.once('dialog', (d) => d.accept('E2E폴더'))
  await page.getByRole('button', { name: /새 폴더/ }).click()
  await expect(page.getByRole('cell', { name: /E2E폴더/ })).toBeVisible()

  await page.locator('input[type="file"]').setInputFiles({
    name: '스모크.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('e2e smoke content'),
  })
  await expect(page.getByRole('cell', { name: /스모크\.txt/ })).toBeVisible()

  // 파일 선택 → 링크 바에 사내 링크 복사 버튼 노출
  await page.getByRole('cell', { name: /스모크\.txt/ }).click()
  await expect(page.getByRole('button', { name: '사내 링크 복사' })).toBeVisible()
})
