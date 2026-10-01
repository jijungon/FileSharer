import { ACCOUNT, RUN_TAG, expect, test } from './fixtures'

import { fileCell } from './helpers'

// '공유 링크' 를 exact 로 찾는 이유: 팝오버 안에도 '사내 공유 링크 복사' 버튼이 있어
// 부분 일치로 둘이 함께 잡힌다. 탭 줄의 버튼은 아이콘만 보이지만 이름은 글자 그대로 남아 있다.

const EMAIL = ACCOUNT.email
const PASSWORD = ACCOUNT.password

test('share link: create in UI, open without login, download', async ({ page, browser }) => {
  // 로그인 후 파일 업로드 → 공유 링크 생성
  await page.goto('/login')
  await page.getByRole('button', { name: /로컬 계정으로 로그인/ }).click()
  await page.getByPlaceholder('이메일').fill(EMAIL)
  await page.getByPlaceholder('비밀번호').fill(PASSWORD)
  await page.getByRole('button', { name: '로컬 계정으로 로그인' }).click()
  await expect(page).toHaveURL(/\/files/)

  await page.locator('input[type="file"]:not([webkitdirectory])').setInputFiles({
    name: `외부공유_${RUN_TAG}.md`,
    mimeType: 'text/markdown',
    buffer: Buffer.from('# 외부 공유 문서\n\n내용입니다.\n'),
  })
  await fileCell(page, `외부공유_${RUN_TAG}.md`).click()
  await page.getByRole('button', { name: '공유 링크', exact: true }).click()
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

test('공유 문서: 목차 이동 · 고정 헤더 · 발급자/발급시각', async ({ page, browser }) => {
  await page.goto('/login')
  await page.getByRole('button', { name: /로컬 계정으로 로그인/ }).click()
  await page.getByPlaceholder('이메일').fill(EMAIL)
  await page.getByPlaceholder('비밀번호').fill(PASSWORD)
  await page.getByRole('button', { name: '로컬 계정으로 로그인' }).click()
  await expect(page).toHaveURL(/\/files/)

  // 스크롤이 생길 만큼 긴 문서(목차·고정 헤더를 실제로 확인하려면 길어야 한다)
  const filler = Array.from({ length: 25 }, (_, i) => `문단 ${i}`).join('\n\n')
  const doc = [
    '# 문서 제목',
    '',
    filler,
    '',
    '## 둘째 장',
    '',
    '```sh',
    '# 코드블록 주석은 목차에 없어야 한다',
    '```',
    '',
    filler,
    '',
    '### 셋째 항목',
    '',
    filler,
  ].join('\n')

  await page.locator('input[type="file"]:not([webkitdirectory])').setInputFiles({
    name: `목차문서_${RUN_TAG}.md`,
    mimeType: 'text/markdown',
    buffer: Buffer.from(doc),
  })
  await fileCell(page, `목차문서_${RUN_TAG}.md`).click()
  await page.getByRole('button', { name: '공유 링크', exact: true }).click()
  await page.getByRole('button', { name: '링크 만들기' }).click()

  // 발급된 링크 목록: 누가(닉네임) · 언제 발급했는지
  const row = page.locator('.share-existing .share-row').first()
  await expect(row).toContainText('e2e') // email_nickname('e2e@test.local')
  await expect(row).toContainText('발급')
  await expect(row).toContainText('만료')

  const urlCode = page.locator('.share-copyrow code', {
    hasText: /^https?:\/\/\S+\/s\/[A-Za-z0-9_-]+$/,
  })
  const shareUrl = (await urlCode.textContent())!.trim()

  const anon = await browser.newContext()
  const anonPage = await anon.newPage()
  await anonPage.goto(shareUrl)

  // 목차는 #/##/### 셋만 (코드블록 안 주석 제외)
  const items = anonPage.locator('.share-toc-item')
  await expect(items).toHaveCount(3)
  await expect(items.nth(0)).toHaveText('문서 제목')
  await expect(items.nth(2)).toHaveText('셋째 항목')

  // 클릭하면 그 문단으로 이동
  const target = anonPage.getByRole('heading', { name: '셋째 항목' })
  await expect(target).not.toBeInViewport()
  await items.nth(2).click()
  await expect(target).toBeInViewport()

  // 스크롤을 내려도 헤더(테마·다운로드)는 계속 보인다
  await expect(anonPage.locator('.share-page-head')).toBeInViewport()
  await expect(anonPage.getByRole('button', { name: '다운로드' })).toBeInViewport()

  // 스크롤만 해도 '지금 보고 있는 문단'이 목차에 표시된다(클릭 없이)
  await anonPage.waitForTimeout(900) // 클릭 직후 잠시 멈춘 추적이 다시 켜지도록
  await anonPage.evaluate(() => window.scrollTo(0, 0))
  await expect(anonPage.locator('.share-toc-item.active')).toHaveText('문서 제목')

  await anonPage.evaluate(() => {
    const h = document.querySelector('.share-page-head')!.getBoundingClientRect().height
    const el = [...document.querySelectorAll('.md-preview h2')].find((x) =>
      x.textContent!.includes('둘째 장'),
    )!
    window.scrollBy(0, el.getBoundingClientRect().top - h - 8)
  })
  await expect(anonPage.locator('.share-toc-item.active')).toHaveText('둘째 장')

  await anonPage.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
  await expect(anonPage.locator('.share-toc-item.active')).toHaveText('셋째 항목')
  await anon.close()
})
