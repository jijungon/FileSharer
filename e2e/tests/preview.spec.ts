import { expect, test } from './fixtures'

import { fileCell } from './helpers'

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
  await page.locator('input[type="file"]:not([webkitdirectory])').setInputFiles({
    name: '픽셀.png',
    mimeType: 'image/png',
    buffer: PNG,
  })
  await fileCell(page, /픽셀\.png/).click()
  await expect(page.locator('.image-preview img')).toBeVisible()
})

test('new MD: modal opens, save creates the file and opens it', async ({ page }) => {
  await loginAsAdmin(page)
  page.once('dialog', (d) => d.accept('회의록'))
  await page.getByRole('button', { name: /새 MD/ }).click()

  // 편집 모달이 뜬다(아직 파일 생성 안 됨) — 에디터 + 프리뷰
  const modal = page.locator('.new-md-modal')
  await expect(modal).toBeVisible()
  await expect(modal.locator('.cm-content')).toBeVisible()
  await expect(modal.locator('.md-preview').getByRole('heading', { name: '회의록' })).toBeVisible()

  // 저장 → 모달 닫히고, 만든 파일이 에디터로 열린다(VS Code식 3분할: 목록 대신 편집기가 뜸)
  await modal.getByRole('button', { name: '저장' }).click()
  await expect(modal).toBeHidden()
  await expect(page.locator('.editor-name')).toContainText('회의록')
})

test('new MD: cancel discards without creating a file', async ({ page }) => {
  await loginAsAdmin(page)
  page.once('dialog', (d) => d.accept('버리는문서'))
  await page.getByRole('button', { name: /새 MD/ }).click()
  const modal = page.locator('.new-md-modal')
  await expect(modal).toBeVisible()
  await modal.getByRole('button', { name: '취소' }).click()
  await expect(modal).toBeHidden()
  // 파일이 생성되지 않았다(트리에도 없음)
  await expect(page.locator('.tree-name').filter({ hasText: /버리는문서\.md/ })).toHaveCount(0)
})
