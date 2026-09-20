import { expect, test } from '@playwright/test'

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
  // 업로드 진행 행이 사라진 뒤(실제 파일 행으로 교체됨) 별표 버튼을 다룬다
  await expect(page.locator('.upload-row')).toHaveCount(0)
  const row = page.getByRole('row', { name: new RegExp(fname) })
  await expect(row).toBeVisible()

  // 행 hover 후 ☆ 클릭 → 즐겨찾기 추가(라벨이 '즐겨찾기 해제'로 바뀜)
  await row.hover()
  await row.getByRole('button', { name: '즐겨찾기', exact: true }).click()
  await expect(row.getByRole('button', { name: '즐겨찾기 해제', exact: true })).toBeVisible()

  // 사이드바 즐겨찾기 뷰 → 그 파일이 보인다 (트리 파일명과 겹치지 않게 사이드바 버튼 특정)
  await page.locator('.sidebar-fav').click()
  const favResult = page.locator('.search-result', { hasText: fname })
  await expect(favResult).toBeVisible()

  // 뷰에서 ★ 눌러 해제 → 목록에서 사라진다
  await favResult.getByRole('button', { name: '즐겨찾기 해제' }).click()
  await expect(page.locator('.search-result', { hasText: fname })).toHaveCount(0)
})
