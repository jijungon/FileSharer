import { expect, test } from './fixtures'

const EMAIL = 'e2e@test.local'
const PASSWORD = 'e2e-password-123'

async function login(page) {
  await page.goto('/login')
  await page.getByRole('button', { name: /로컬 계정으로 로그인/ }).click()
  await page.getByPlaceholder('이메일').fill(EMAIL)
  await page.getByPlaceholder('비밀번호').fill(PASSWORD)
  await page.getByRole('button', { name: '로컬 계정으로 로그인' }).click()
  await expect(page).toHaveURL(/\/files/)
}

// 코드 파일(.py 등)은 이제 텍스트로 인식되어 편집기로 열리고, 코드라 프리뷰 없이 풀폭이다.
// (문법 강조 색 자체는 CodeMirror 내부 클래스라 시각으로 검증했고, 여기선 '에디터로 열림 +
//  프리뷰 없음'을 회귀 방지로 단언한다.)
test('코드 파일(.py)은 편집기로 열리고 프리뷰 없이 풀폭이다', async ({ page }) => {
  await login(page)
  await page.locator('input[type="file"]:not([webkitdirectory])').setInputFiles({
    name: 'script.py',
    mimeType: 'text/x-python',
    buffer: Buffer.from('import os\n\n\ndef f(x):\n    return x + 1\n'),
  })
  await expect(page.locator('.upload-row')).toHaveCount(0)

  // 트리에서 열기 → 다운로드 카드가 아니라 '편집기'로 열린다
  await page.locator('.tree-name').filter({ hasText: 'script.py' }).click()
  await expect(page.locator('.editor-shell')).toBeVisible()
  await expect(page.locator('.cm-editor')).toBeVisible()
  // 코드 파일은 마크다운과 달리 프리뷰 패널이 없다(에디터 풀폭)
  await expect(page.locator('.preview-pane')).toHaveCount(0)
})

test('마크다운(.md)은 여전히 편집|프리뷰 분할로 열린다', async ({ page }) => {
  await login(page)
  await page.locator('input[type="file"]:not([webkitdirectory])').setInputFiles({
    name: 'doc.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from('# 제목\n\n본문'),
  })
  await expect(page.locator('.upload-row')).toHaveCount(0)
  await page.locator('.tree-name').filter({ hasText: 'doc.md' }).click()
  await expect(page.locator('.editor-shell')).toBeVisible()
  await expect(page.locator('.preview-pane')).toBeVisible() // md는 프리뷰 유지
})
