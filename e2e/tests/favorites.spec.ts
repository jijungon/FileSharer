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

test('별표로 즐겨찾기에 추가하고, 즐겨찾기 뷰에서 해제한다', async ({ page }) => {
  await login(page)
  const tag = Date.now()
  const fname = `즐겨_${tag}.txt`

  await page.locator('input[type="file"]:not([webkitdirectory])').setInputFiles({
    name: fname,
    mimeType: 'text/plain',
    buffer: Buffer.from('x'),
  })
  // 업로드 진행 패널이 사라진 뒤(실제 파일로 교체됨) 트리 항목을 다룬다
  await expect(page.locator('.upload-row')).toHaveCount(0)
  const item = page.locator('.tree-name').filter({ hasText: fname })
  await expect(item).toBeVisible()

  // 트리 항목 앞쪽(이모지 왼쪽)의 ☆ 별을 눌러 즐겨찾기
  const favBtn = page.locator('.tree-row').filter({ hasText: fname }).locator('.tree-fav')
  await favBtn.click()
  // 즐겨찾기가 서버까지 반영돼 별이 채워진 뒤(★)에 뷰를 전환한다 — 반영 전에 전환하면
  // 즐겨찾기 목록이 비어 보이던 레이스(CI 플래키) 방지
  await expect(favBtn).toHaveAttribute('aria-label', '즐겨찾기 해제')

  // 사이드바 툴바의 ★ 즐겨찾기 아이콘 → 즐겨찾기 뷰로 전환, 그 파일이 보인다
  await page.locator('.sidebar-fav-toggle').click()
  const favResult = page.locator('.search-result', { hasText: fname })
  await expect(favResult).toBeVisible()

  // 뷰에서 ★ 눌러 해제 → 목록에서 사라진다
  await favResult.getByRole('button', { name: '즐겨찾기 해제' }).click()
  await expect(page.locator('.search-result', { hasText: fname })).toHaveCount(0)
})
