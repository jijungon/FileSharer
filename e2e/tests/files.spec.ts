import { expect, test } from '@playwright/test'

import { fileCell } from './helpers'

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

  page.once('dialog', (d) => d.accept('E2E폴더'))
  await page.getByRole('button', { name: /새 폴더/ }).click()
  await expect(page.getByRole('cell', { name: /E2E폴더/ })).toBeVisible()

  await page.locator('input[type="file"]:not([webkitdirectory])').setInputFiles({
    name: '스모크.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('e2e smoke content'),
  })
  await expect(fileCell(page, /스모크\.txt/)).toBeVisible()

  // 파일 선택 → 링크 바에 사내 링크 복사 버튼 노출
  await fileCell(page, /스모크\.txt/).click()
  await expect(page.getByRole('button', { name: '사내 링크 복사' })).toBeVisible()
})

// 1x1 투명 PNG (텍스트가 아닌 미리보기 = MediaPreview 경로)
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
)

test('non-text viewer (image/pdf) can maximize and restore', async ({ page }) => {
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

  // 이미지 뷰어(비텍스트)에도 전체화면 버튼이 있어야 하고, 누르면 사이드바(트리)가 숨겨진다
  // (VS Code식 레이아웃: 전체화면 = 사이드바만 숨기고 뷰어가 폭을 꽉 채움)
  await expect(page.locator('.sidebar')).toBeVisible()
  await page.getByRole('button', { name: '전체화면' }).click()
  await expect(page.locator('.sidebar')).toBeHidden()
  // 분할 보기로 되돌리면 다시 보인다
  await page.getByRole('button', { name: '분할 보기' }).click()
  await expect(page.locator('.sidebar')).toBeVisible()
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
  page.once('dialog', (d) => d.accept(folder))
  await page.getByRole('button', { name: /새 폴더/ }).click()
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
