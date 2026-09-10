import { expect, test } from '@playwright/test'

const EMAIL = 'e2e@test.local'
const PASSWORD = 'e2e-password-123'

test('share link: create in UI, open without login, download', async ({ page, browser }) => {
  // 로그인 후 파일 업로드 → 공유 링크 생성
  await page.goto('/login')
  await page.getByRole('button', { name: /로컬 계정으로 로그인/ }).click()
  await page.getByPlaceholder('이메일').fill(EMAIL)
  await page.getByPlaceholder('비밀번호').fill(PASSWORD)
  await page.getByRole('button', { name: '로컬 계정으로 로그인' }).click()
  await expect(page).toHaveURL(/\/files/)

  await page.locator('input[type="file"]').setInputFiles({
    name: '외부공유.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from('# 외부 공유 문서\n\n내용입니다.\n'),
  })
  await page.getByRole('cell', { name: /외부공유\.md/ }).click()
  await page.getByRole('button', { name: '공유 링크' }).click()
  await page.getByRole('button', { name: '링크 만들기' }).click()

  const urlCode = page.locator('.share-copyrow code').first()
  await expect(urlCode).toContainText('/s/')
  const shareUrl = (await urlCode.textContent())!.trim()

  // 비로그인 컨텍스트에서 공유 페이지 열람 + 렌더 확인
  const anon = await browser.newContext()
  const anonPage = await anon.newPage()
  await anonPage.goto(shareUrl)
  await expect(anonPage.getByRole('heading', { name: '외부 공유 문서' })).toBeVisible()

  // 비로그인 다운로드
  const dl = await anonPage.request.get(`${shareUrl}/download`)
  expect(dl.ok()).toBeTruthy()
  expect((await dl.body()).toString()).toContain('외부 공유 문서')
  await anon.close()
})
