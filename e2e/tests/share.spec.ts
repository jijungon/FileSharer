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

  // 행 순서와 무관하게 '순수 URL'인 code만 선택 (첫 행은 원커맨드일 수 있음)
  const urlCode = page.locator('.share-copyrow code', {
    hasText: /^https?:\/\/\S+\/s\/[A-Za-z0-9_-]+$/,
  })
  await expect(urlCode).toBeVisible()
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
