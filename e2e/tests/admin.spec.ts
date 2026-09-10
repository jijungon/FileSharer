import { expect, test } from '@playwright/test'

test('admin system tab: disk, audit log, trash manager', async ({ page }) => {
  await page.goto('/login')
  await page.getByRole('button', { name: /로컬 계정으로 로그인/ }).click()
  await page.getByPlaceholder('이메일').fill('e2e@test.local')
  await page.getByPlaceholder('비밀번호').fill('e2e-password-123')
  await page.getByRole('button', { name: '로컬 계정으로 로그인' }).click()
  await expect(page).toHaveURL(/\/files/)

  // 감사 로그에 뭔가 남도록 파일 하나 업로드
  await page.locator('input[type="file"]').setInputFiles({
    name: '운영.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('ops'),
  })
  await expect(page.getByRole('cell', { name: /운영\.txt/ })).toBeVisible()

  await page.getByRole('button', { name: '관리' }).click()
  await page.getByRole('button', { name: '시스템' }).click()

  await expect(page.locator('.disk-bar')).toBeVisible()
  await expect(page.getByRole('heading', { name: '감사 로그' })).toBeVisible()
  await expect(page.getByRole('cell', { name: 'upload' }).first()).toBeVisible()
})
