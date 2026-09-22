import { expect, test } from './fixtures'

import { fileCell, newFolder } from './helpers'

const EMAIL = 'e2e@test.local'
const PASSWORD = 'e2e-password-123'

test('local login → browse → create folder → upload file', async ({ page }) => {
  await page.goto('/login')
  await page.getByRole('button', { name: /로컬 계정으로 로그인/ }).click()
  await page.getByPlaceholder('이메일').fill(EMAIL)
  await page.getByPlaceholder('비밀번호').fill(PASSWORD)
  await page.getByRole('button', { name: '로컬 계정으로 로그인' }).click()

  await expect(page).toHaveURL(/\/files/)
  await expect(page.locator('.space-item.space-root', { hasText: '내 공간' })).toBeVisible()

  await newFolder(page, 'E2E폴더')
  await expect(page.locator('.tree-name').filter({ hasText: /E2E폴더/ })).toBeVisible()

  await page.locator('input[type="file"]:not([webkitdirectory])').setInputFiles({
    name: '스모크.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('e2e smoke content'),
  })
  await expect(fileCell(page, /스모크\.txt/)).toBeVisible()

  // 파일 열기 → 공유 링크 팝오버 안에 '사내 링크 복사'가 있다(액션 바에서 팝오버로 이동됨)
  await fileCell(page, /스모크\.txt/).click()
  await page.locator('.editor-toolbar').getByRole('button', { name: '공유 링크' }).click()
  await expect(
    page.locator('.share-popover').getByRole('button', { name: /사내 링크 복사/ }),
  ).toBeVisible()
})

// 1x1 투명 PNG (텍스트가 아닌 미리보기 = MediaPreview 경로)
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
)

test('비텍스트 뷰어(이미지)를 열어도 사이드바는 그대로 보인다(전체화면 버튼 제거)', async ({ page }) => {
  await page.goto('/login')
  await page.getByRole('button', { name: /로컬 계정으로 로그인/ }).click()
  await page.getByPlaceholder('이메일').fill(EMAIL)
  await page.getByPlaceholder('비밀번호').fill(PASSWORD)
  await page.getByRole('button', { name: '로컬 계정으로 로그인' }).click()
  await expect(page).toHaveURL(/\/files/)

  await page.locator('input[type="file"]:not([webkitdirectory])').setInputFiles({
    name: '사진.png',
    mimeType: 'image/png',
    buffer: PNG_1x1,
  })
  await fileCell(page, /사진\.png/).click()

  // 이미지 뷰어가 인라인으로 열리고, 사이드바(트리)는 계속 보인다. 전체화면 버튼은 없어졌다.
  await expect(page.locator('.image-preview img')).toBeVisible()
  await expect(page.locator('.sidebar')).toBeVisible()
  await expect(page.getByRole('button', { name: '전체화면' })).toHaveCount(0)
})

test('browser back/forward syncs the folder view', async ({ page }) => {
  await page.goto('/login')
  await page.getByRole('button', { name: /로컬 계정으로 로그인/ }).click()
  await page.getByPlaceholder('이메일').fill(EMAIL)
  await page.getByPlaceholder('비밀번호').fill(PASSWORD)
  await page.getByRole('button', { name: '로컬 계정으로 로그인' }).click()
  await expect(page).toHaveURL(/\/files/)

  // 루트에 폴더 생성 → 사이드바 트리에서 클릭해 진입(SPA 이동)
  const folder = `뒤로폴더-${Date.now()}`
  await newFolder(page, folder)
  await page.locator('.tree-name', { hasText: folder }).click()
  await expect(page.locator('.crumb-current, .crumb', { hasText: folder })).toBeVisible()
  await expect(page).toHaveURL(/\/files\/.+/)

  // 브라우저 뒤로가기 → URL도 화면 상태도 루트로 (예전엔 URL만 바뀌고 화면은 안 바뀜)
  await page.goBack()
  await expect(page).toHaveURL(/\/files$/)
  await expect(page.locator('.crumb-current, .crumb', { hasText: folder })).toHaveCount(0)

  // 앞으로가기 → 다시 폴더 안
  await page.goForward()
  await expect(page).toHaveURL(/\/files\/.+/)
  await expect(page.locator('.crumb-current, .crumb', { hasText: folder })).toBeVisible()
})
