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

test('업로드 중 파일 목록에 진행 행이 뜨고, 완료되면 실제 파일로 바뀐다', async ({ page }) => {
  await loginAsAdmin(page)

  // 업로드 요청을 잠시 지연 → XHR pending 동안 인라인 진행 행이 보여야 한다
  await page.route('**/api/spaces/*/files', async (route) => {
    await new Promise((r) => setTimeout(r, 1500))
    await route.continue()
  })

  await page.locator('input[type="file"]:not([webkitdirectory])').setInputFiles({
    name: '진행.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('x'.repeat(2000)),
  })

  const uploadRow = page.locator('.upload-row')
  await expect(uploadRow).toContainText('진행.txt')
  await expect(uploadRow.locator('.upload-inline-bar')).toBeVisible()

  // 완료되면 진행 행이 사라지고 실제 파일 행으로 바뀐다
  await expect(page.locator('.upload-row')).toHaveCount(0, { timeout: 6000 })
  await expect(page.getByRole('cell', { name: /진행\.txt/ })).toBeVisible()
})

test('여러 파일 업로드 시 툴바에 전체 개수가 표시되고, 각 파일이 진행 행으로 뜬다', async ({ page }) => {
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

  // 툴바 개수(…/3) + 세 개의 인라인 진행 행
  await expect(page.locator('.upload-count')).toContainText('/3')
  await expect(page.locator('.upload-row')).toHaveCount(3)

  // 모두 끝나면 진행 행이 사라지고 실제 파일이 나타난다
  await expect(page.locator('.upload-row')).toHaveCount(0, { timeout: 6000 })
  await expect(page.getByRole('cell', { name: /다중2\.txt/ })).toBeVisible()
})

test('일부 업로드가 실패하면 그 행만 실패로 표시되고 나머지는 완료된다', async ({ page }) => {
  await loginAsAdmin(page)

  // multipart 본문의 파일명으로 대상 구분: '실패.txt' 요청만 500, 나머지는 통과
  await page.route('**/api/spaces/*/files', async (route) => {
    const body = route.request().postData() ?? ''
    if (body.includes('실패.txt')) {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ detail: '서버 오류' }),
      })
    } else {
      // 성공 파일을 잠시 지연 → 배치가 바로 끝나 진행 행이 사라지기 전에 실패 행을 검증
      await new Promise((r) => setTimeout(r, 2000))
      await route.continue()
    }
  })

  await page.locator('input[type="file"]:not([webkitdirectory])').setInputFiles([
    { name: '성공A.txt', mimeType: 'text/plain', buffer: Buffer.from('a') },
    { name: '실패.txt', mimeType: 'text/plain', buffer: Buffer.from('b') },
  ])

  // 실패 행은 error 상태 + '실패' 표기, 툴바 개수에 실패 1
  const errorRow = page.locator('.upload-row.error')
  await expect(errorRow).toContainText('실패.txt')
  await expect(errorRow.locator('.upload-inline-pct')).toContainText('실패')
  await expect(page.locator('.upload-count')).toContainText('실패 1')

  // 실패해도 성공한 파일은 목록에 나타난다
  await expect(page.getByRole('cell', { name: /성공A\.txt/ })).toBeVisible()
})
