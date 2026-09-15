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

test('업로드 중 진행 패널이 뜨고, 완료되면 사라진다', async ({ page }) => {
  await loginAsAdmin(page)

  // 업로드 요청을 잠시 지연 → XHR pending 동안 진행 패널이 보여야 한다
  await page.route('**/api/spaces/*/files', async (route) => {
    await new Promise((r) => setTimeout(r, 1500))
    await route.continue()
  })

  await page.locator('input[type="file"]:not([webkitdirectory])').setInputFiles({
    name: '진행.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('x'.repeat(2000)),
  })

  const panel = page.locator('.upload-progress')
  await expect(panel).toBeVisible()
  await expect(panel.locator('.upload-progress-row')).toContainText('진행.txt')
  await expect(panel.locator('.upload-progress-bar')).toBeVisible()

  // 완료되면 패널이 사라진다
  await expect(panel).toBeHidden({ timeout: 6000 })
  // 파일은 목록에 나타난다
  await expect(page.getByRole('cell', { name: /진행\.txt/ })).toBeVisible()
})

test('여러 파일 업로드 시 진행 패널에 전체 개수가 표시된다', async ({ page }) => {
  await loginAsAdmin(page)

  await page.route('**/api/spaces/*/files', async (route) => {
    await new Promise((r) => setTimeout(r, 1500))
    await route.continue()
  })

  await page.locator('input[type="file"]:not([webkitdirectory])').setInputFiles([
    { name: '다중1.txt', mimeType: 'text/plain', buffer: Buffer.from('a'.repeat(1000)) },
    { name: '다중2.txt', mimeType: 'text/plain', buffer: Buffer.from('b'.repeat(1000)) },
    { name: '다중3.txt', mimeType: 'text/plain', buffer: Buffer.from('c'.repeat(1000)) },
  ])

  const panel = page.locator('.upload-progress')
  await expect(panel).toBeVisible()
  // 헤더에 전체 개수(…/3) — 세 항목 모두 한 배치로 추적된다
  await expect(panel.locator('.upload-progress-head')).toContainText('/3')
  await expect(panel.locator('.upload-progress-row')).toHaveCount(3)
  // 모두 끝나면 3/3까지 올라간 뒤 패널이 사라진다
  await expect(panel.locator('.upload-progress-head')).toContainText('3/3', { timeout: 6000 })
  await expect(panel).toBeHidden({ timeout: 6000 })
  await expect(page.getByRole('cell', { name: /다중2\.txt/ })).toBeVisible()
})
