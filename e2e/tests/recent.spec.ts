import { expect, test } from './fixtures'

import { fileCell } from './helpers'

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

test('파일을 열면 "최근" 뷰에 쌓이고, 클릭하면 다시 열린다', async ({ page }) => {
  await login(page)
  const tag = Date.now()
  const fname = `최근_${tag}.md`

  await page.locator('input[type="file"]:not([webkitdirectory])').setInputFiles({
    name: fname,
    mimeType: 'text/markdown',
    buffer: Buffer.from('# 최근 문서\n\n본문'),
  })
  const cell = fileCell(page, new RegExp(fname))
  await expect(cell).toBeVisible()

  // 파일 열기 → 뷰어 뜸(= 열람 기록됨)
  await cell.click()
  await expect(page.locator('.viewer-area')).toBeVisible()

  // 사이드바 인라인 '최근'(MAX 5)에 방금 연 파일이 나타난다(직렬 실행이라 최상단)
  const recentItem = page.locator('.recent-inline .recent-item', { hasText: fname })
  await expect(recentItem).toBeVisible()

  // 공간 루트로 나가 뷰어를 닫는다
  await page.locator('.space-item.space-root.active').click()
  await expect(page.locator('.viewer-area')).toHaveCount(0)

  // 인라인 최근 항목 클릭 → 다시 뷰어로 열림
  await page.locator('.recent-inline .recent-item', { hasText: fname }).click()
  await expect(page.locator('.viewer-area')).toBeVisible()
})
