import { expect, test } from '@playwright/test'

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

  await page.locator('input[type="file"]').setInputFiles({
    name: '스모크.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('e2e smoke content'),
  })
  await expect(page.getByRole('cell', { name: /스모크\.txt/ })).toBeVisible()

  // 파일 선택 → 링크 바에 사내 링크 복사 버튼 노출
  await page.getByRole('cell', { name: /스모크\.txt/ }).click()
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

  await page.locator('input[type="file"]').setInputFiles({
    name: '사진.png',
    mimeType: 'image/png',
    buffer: PNG_1x1,
  })
  await page.getByRole('cell', { name: /사진\.png/ }).click()

  // 이미지 뷰어(비텍스트)에도 전체화면 버튼이 있어야 하고, 누르면 파일 브라우저가 숨겨진다
  await expect(page.locator('.workspace')).toBeVisible()
  await page.getByRole('button', { name: '전체화면' }).click()
  await expect(page.locator('.workspace')).toBeHidden()
  // 분할 보기로 되돌리면 다시 보인다
  await page.getByRole('button', { name: '분할 보기' }).click()
  await expect(page.locator('.workspace')).toBeVisible()
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

test('viewer resize handle works when dragging down over an iframe preview', async ({ page }) => {
  await page.goto('/login')
  await page.getByRole('button', { name: /로컬 계정으로 로그인/ }).click()
  await page.getByPlaceholder('이메일').fill(EMAIL)
  await page.getByPlaceholder('비밀번호').fill(PASSWORD)
  await page.getByRole('button', { name: '로컬 계정으로 로그인' }).click()
  await expect(page).toHaveURL(/\/files/)

  // HTML 파일 = iframe 뷰어 (핸들 아래로 끌면 커서가 iframe 위를 지나감)
  await page.locator('input[type="file"]').setInputFiles({
    name: '리사이즈.html',
    mimeType: 'text/html',
    buffer: Buffer.from('<h1>resize drag test</h1>'),
  })
  await page.getByRole('cell', { name: /리사이즈\.html/ }).click()

  const viewer = page.locator('.viewer-area')
  await expect(viewer).toBeVisible()
  const before = (await viewer.boundingBox())!.height

  // 핸들을 아래로 끌면 뷰어가 작아져야 한다. iframe이 이벤트를 가로채면 안 움직임(버그).
  const handle = page.locator('.vsplit-handle')
  const hb = (await handle.boundingBox())!
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2)
  await page.mouse.down()
  await page.mouse.move(hb.x + hb.width / 2, hb.y + 160, { steps: 12 })
  await page.mouse.up()

  const after = (await viewer.boundingBox())!.height
  expect(after).toBeLessThan(before - 40)
})
