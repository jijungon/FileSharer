import { expect, test } from '@playwright/test'

const EMAIL = 'e2e@test.local'
const PASSWORD = 'e2e-password-123'

test('markdown editor: open → live preview → edit → save', async ({ page }) => {
  await page.goto('/login')
  await page.getByRole('button', { name: /로컬 계정으로 로그인/ }).click()
  await page.getByPlaceholder('이메일').fill(EMAIL)
  await page.getByPlaceholder('비밀번호').fill(PASSWORD)
  await page.getByRole('button', { name: '로컬 계정으로 로그인' }).click()
  await expect(page).toHaveURL(/\/files/)

  await page.locator('input[type="file"]').setInputFiles({
    name: '에디터.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from('# 제목\n\n- 항목 하나\n'),
  })
  const row = page.getByRole('cell', { name: /에디터\.md/ })
  await expect(row).toBeVisible()
  await row.click()

  // T자 하단: 좌 편집기 / 우 렌더링
  await expect(page.locator('.cm-content')).toBeVisible()
  await expect(page.locator('.md-preview').getByRole('heading', { name: '제목' })).toBeVisible()

  // 편집 → 실시간 렌더 반영
  await page.locator('.cm-content').click()
  await page.keyboard.type('수정됨 ')
  await expect(page.locator('.md-preview').getByText(/수정됨/)).toBeVisible()
  await expect(page.getByText('● 저장 안 됨')).toBeVisible()

  // 저장 → 상태 갱신
  await page.getByRole('button', { name: /저장 ⌘S/ }).click()
  await expect(page.getByText(/저장됨/).first()).toBeVisible()
})
