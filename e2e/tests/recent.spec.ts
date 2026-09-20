import { expect, test } from '@playwright/test'

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

  // 사이드바 '최근' 뷰 → 방금 연 파일이 보인다
  // (트리에 파일까지 표시되므로 /최근/ 정규식은 파일명과도 겹친다 → 사이드바 버튼을 특정)
  await page.locator('.sidebar-recent').click()
  const recentRow = page.locator('.search-result', { hasText: fname })
  await expect(recentRow).toBeVisible()

  // 최근 항목 클릭 → 다시 뷰어로 열림
  await recentRow.click()
  await expect(page.locator('.search-results')).toHaveCount(0)
  await expect(page.locator('.viewer-area')).toBeVisible()
})
