import { expect, test } from '@playwright/test'

const EMAIL = 'e2e@test.local'
const PASSWORD = 'e2e-password-123'

async function loginAsAdmin(page) {
  await page.goto('/login')
  await page.getByRole('button', { name: /로컬 계정으로 로그인/ }).click()
  await page.getByPlaceholder('이메일').fill(EMAIL)
  await page.getByPlaceholder('비밀번호').fill(PASSWORD)
  await page.getByRole('button', { name: '로컬 계정으로 로그인' }).click()
  await expect(page).toHaveURL(/\/files/)
}

test('MD 에디터와 프리뷰가 함께 스크롤된다(양방향)', async ({ page }) => {
  await loginAsAdmin(page)

  const long = Array.from({ length: 150 }, (_, i) => `## 섹션 ${i}\n\n${'가나다라마바사 '.repeat(8)}\n`).join(
    '\n',
  )
  await page.locator('input[type="file"]:not([webkitdirectory])').setInputFiles({
    name: '긴문서.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from(long),
  })
  await page.getByRole('cell', { name: /긴문서\.md/ }).click()

  const editor = page.locator('.editor-pane') // 실제 스크롤 컨테이너
  const preview = page.locator('.preview-pane')
  await expect(editor).toBeVisible()
  await expect(preview.locator('.md-preview')).toBeVisible()

  // 에디터를 맨 아래로 → 프리뷰도 따라 내려간다
  await editor.evaluate((el) => {
    el.scrollTop = el.scrollHeight
  })
  await expect
    .poll(() => preview.evaluate((el) => el.scrollTop), { timeout: 4000 })
    .toBeGreaterThan(50)

  // 프리뷰를 맨 위로 → 에디터도 따라 올라간다
  await preview.evaluate((el) => {
    el.scrollTop = 0
  })
  await expect.poll(() => editor.evaluate((el) => el.scrollTop), { timeout: 4000 }).toBeLessThan(30)
})

test('새 MD 모달도 에디터↔프리뷰 스크롤 동기화된다', async ({ page }) => {
  await loginAsAdmin(page)
  page.once('dialog', (d) => d.accept('스크롤테스트'))
  await page.getByRole('button', { name: /새 MD/ }).click()

  const modal = page.locator('.new-md-modal')
  await expect(modal).toBeVisible()
  // 긴 내용 삽입(스크롤 가능하게)
  await modal.locator('.cm-content').click()
  const long = '\n' + Array.from({ length: 120 }, (_, i) => `## 섹션 ${i}\n라인 ${i}`).join('\n')
  await page.keyboard.insertText(long)

  const editor = modal.locator('.editor-pane')
  const preview = modal.locator('.preview-pane')
  await expect(preview.locator('.md-preview').getByRole('heading', { name: '섹션 110' })).toBeVisible()

  // 에디터를 맨 아래로 → 프리뷰도 따라 내려간다
  await editor.evaluate((el) => {
    el.scrollTop = el.scrollHeight
  })
  await expect
    .poll(() => preview.evaluate((el) => el.scrollTop), { timeout: 4000 })
    .toBeGreaterThan(50)
})
