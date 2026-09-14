import { expect, test } from '@playwright/test'

const EMAIL = 'e2e@test.local'
const PASSWORD = 'e2e-password-123'

test('sidebar folder tree navigates into folders and back to root', async ({ page }) => {
  await page.goto('/login')
  await page.getByRole('button', { name: /로컬 계정으로 로그인/ }).click()
  await page.getByPlaceholder('이메일').fill(EMAIL)
  await page.getByPlaceholder('비밀번호').fill(PASSWORD)
  await page.getByRole('button', { name: '로컬 계정으로 로그인' }).click()
  await expect(page).toHaveURL(/\/files/)

  const parent = `트리부모-${Date.now()}`

  // 루트에 폴더 생성
  page.once('dialog', (d) => d.accept(parent))
  await page.getByRole('button', { name: /새 폴더/ }).click()
  await expect(page.getByRole('cell', { name: parent })).toBeVisible()

  // 사이드바 트리에 폴더가 나타난다 → 클릭해 들어가기
  const treeItem = page.locator('.tree-name', { hasText: parent })
  await expect(treeItem).toBeVisible()
  await treeItem.click()

  // 링크바 경로(브레드크럼)에 폴더명이 보이고, 그 폴더 안(비어 있음)으로 진입
  await expect(page.locator('.crumb-current, .crumb', { hasText: parent })).toBeVisible()
  await expect(page).toHaveURL(/\/files\/.+/)

  // 하위 폴더 생성 → 트리에서 부모 아래에 나타남
  const child = `트리자식-${Date.now()}`
  page.once('dialog', (d) => d.accept(child))
  await page.getByRole('button', { name: /새 폴더/ }).click()
  await expect(page.locator('.tree-name', { hasText: child })).toBeVisible()

  // 트리 루트(🗂 공간명)를 눌러 최상위로 복귀
  await page.locator('.tree-root .tree-name').click()
  await expect(page).toHaveURL(/\/files$/)
})
