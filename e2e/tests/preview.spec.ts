import { expect, test } from '@playwright/test'

const EMAIL = 'e2e@test.local'
const PASSWORD = 'e2e-password-123'
// 1x1 투명 PNG
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
)

async function loginAsAdmin(page) {
  await page.goto('/login')
  await page.getByRole('button', { name: /로컬 계정으로 로그인/ }).click()
  await page.getByPlaceholder('이메일').fill(EMAIL)
  await page.getByPlaceholder('비밀번호').fill(PASSWORD)
  await page.getByRole('button', { name: '로컬 계정으로 로그인' }).click()
  await expect(page).toHaveURL(/\/files/)
}

test('image preview renders inline', async ({ page }) => {
  await loginAsAdmin(page)
  await page.locator('input[type="file"]').setInputFiles({
    name: '픽셀.png',
    mimeType: 'image/png',
    buffer: PNG,
  })
  await page.getByRole('cell', { name: /픽셀\.png/ }).click()
  await expect(page.locator('.image-preview img')).toBeVisible()
})

test('new MD button creates a doc and opens the editor', async ({ page }) => {
  await loginAsAdmin(page)
  page.once('dialog', (d) => d.accept('회의록'))
  await page.getByRole('button', { name: /새 MD/ }).click()
  await expect(page.locator('.cm-content')).toBeVisible()
  await expect(page.locator('.md-preview').getByRole('heading', { name: '회의록' })).toBeVisible()
})
