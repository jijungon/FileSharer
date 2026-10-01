import { ACCOUNT, RUN_TAG, expect, loginAs, test } from './fixtures'

import { fileCell } from './helpers'

/**
 * 공유 링크의 **차단 장치** — 비밀번호 · 횟수 제한 · 회수 · 없는 토큰.
 *
 * share.spec.ts 는 "링크를 만들면 로그인 없이 열리고 받아진다"는 행복한 길만 본다.
 * 그런데 /s/<토큰> 은 **로그인 없이 인터넷에서 닿는 유일한 표면**이다. 여기가 뚫리면
 * 사내 파일이 그대로 나간다. 그래서 '열려야 한다'보다 '안 열려야 한다'가 더 중요하다.
 *
 * 차단은 전부 서버가 한다(공유 페이지는 SPA라 화면 검사만으로는 아무것도 증명하지 못한다).
 * 그래서 화면과 함께 **비로그인 HTTP 응답의 상태코드**를 직접 확인한다.
 */

// '공유 링크' 를 exact 로 찾는 이유는 share.spec.ts 와 같다 — 주소창의
// aria-label="사내 공유 링크 복사" 가 부분 일치로 함께 잡힌다.
const SHARE_BTN = { name: '공유 링크', exact: true } as const

async function upload(page: import('@playwright/test').Page, name: string, body: string) {
  await page.locator('input[type="file"]:not([webkitdirectory])').setInputFiles({
    name,
    mimeType: 'text/markdown',
    buffer: Buffer.from(body),
  })
  await expect(fileCell(page, name)).toBeVisible()
}

/** 파일 하나를 올리고 공유 링크를 만들어 주소를 돌려준다. 팝오버는 열어 둔 채로 둔다. */
async function share(
  page: import('@playwright/test').Page,
  slug: string,
  opts: { password?: string; maxDownloads?: number } = {},
) {
  const name = `${slug}_${RUN_TAG}.md`
  await upload(page, name, `# ${slug}\n\n비밀 내용\n`)
  await fileCell(page, name).click()
  await page.getByRole('button', SHARE_BTN).click()

  if (opts.password) await page.getByPlaceholder('없음').fill(opts.password)
  if (opts.maxDownloads) await page.getByPlaceholder('무제한').fill(String(opts.maxDownloads))
  await page.getByRole('button', { name: '링크 만들기' }).click()

  // 첫 행은 원커맨드일 수 있으므로 '순수 URL' 모양인 code 만 고른다
  const urlCode = page.locator('.share-copyrow code', {
    hasText: /^https?:\/\/\S+\/s\/[A-Za-z0-9_-]+$/,
  })
  await expect(urlCode).toBeVisible()
  return (await urlCode.textContent())!.trim()
}

test('비밀번호 링크: 비밀번호 없이는 내용이 나가지 않는다', async ({ page, browser }) => {
  await loginAs(page, ACCOUNT)
  const url = await share(page, '비번공유', { password: 'share-pw-123' })

  const anon = await browser.newContext()

  // 미리보기도 다운로드도 전부 막혀야 한다 — 한쪽만 막으면 다른 쪽으로 새어 나간다
  expect((await anon.request.get(`${url}/raw`)).status()).toBe(401)
  expect((await anon.request.get(`${url}/download`)).status()).toBe(401)

  // 틀린 비밀번호도 막힌다
  const wrong = await anon.request.get(`${url}/raw`, {
    headers: { 'X-Share-Password': 'not-the-password' },
  })
  expect(wrong.status()).toBe(401)

  // 맞는 비밀번호라야 열린다
  const ok = await anon.request.get(`${url}/raw`, {
    headers: { 'X-Share-Password': 'share-pw-123' },
  })
  expect(ok.status()).toBe(200)
  expect((await ok.body()).toString()).toContain('비밀 내용')

  await anon.close()
})

test('비밀번호 링크: 이름과 크기는 알려주되 내용은 안 준다', async ({ page, browser }) => {
  // meta 가 막히면 화면이 비밀번호를 물어볼 수조차 없다. 새어 나가도 되는 것과
  // 안 되는 것의 경계라 일부러 고정해 둔다.
  await loginAs(page, ACCOUNT)
  const url = await share(page, '메타공유', { password: 'share-pw-123' })

  const anon = await browser.newContext()
  const meta = await anon.request.get(`${url}/meta`)
  expect(meta.status()).toBe(200)

  const body = await meta.json()
  expect(body.protected).toBe(true)
  expect(body.name).toContain('메타공유')
  expect(JSON.stringify(body)).not.toContain('비밀 내용')

  await anon.close()
})

test('횟수 제한: 정해진 횟수를 넘기면 더 받을 수 없다', async ({ page, browser }) => {
  await loginAs(page, ACCOUNT)
  const url = await share(page, '한번만', { maxDownloads: 1 })

  const anon = await browser.newContext()

  const first = await anon.request.get(`${url}/download`)
  expect(first.status()).toBe(200)
  expect((await first.body()).toString()).toContain('비밀 내용')

  // 두 번째는 끊긴다 (410 = 링크는 있었지만 더는 못 쓴다)
  expect((await anon.request.get(`${url}/download`)).status()).toBe(410)

  await anon.close()
})

test('회수한 링크는 즉시 죽는다', async ({ page, browser }) => {
  await loginAs(page, ACCOUNT)
  const url = await share(page, '폐기대상')

  const anon = await browser.newContext()
  expect((await anon.request.get(`${url}/download`)).status()).toBe(200)

  // 팝오버의 '발급된 링크' 목록에서 회수.
  // 반드시 그 목록 안에서 exact 로 찾는다 — getByRole 의 name 은 부분 일치라,
  // 파일명이 '회수'를 품고 있으면 그 행의 버튼들까지 함께 잡힌다(실제로 겪었다).
  const revoke = page.locator('.share-existing').getByRole('button', { name: '회수', exact: true })
  await expect(revoke).toHaveCount(1)

  // **눈에 보이는지까지 본다.** toBeVisible() 로는 부족하다 — Playwright 는 opacity:0 을
  // '보인다'로 친다. 실제로 .row-action 의 숨김 규칙을 바꾸면서 이 버튼과 팝오버의
  // '닫기 ✕' 가 투명해진 채 배포된 적이 있다(v1.0.4). 클릭은 되니 테스트는 다 통과했다.
  await expect(revoke).toHaveCSS('opacity', '1')
  await expect(page.locator('.share-popover').getByRole('button', { name: /닫기/ })).toHaveCSS(
    'opacity',
    '1',
  )

  await revoke.click()
  await expect(revoke).toHaveCount(0)

  expect((await anon.request.get(`${url}/download`)).status()).toBe(410)
  expect((await anon.request.get(`${url}/raw`)).status()).toBe(410)

  // 화면에도 사유가 뜬다 (빈 페이지로 두면 사람이 왜 안 되는지 모른다)
  const anonPage = await anon.newPage()
  await anonPage.goto(url)
  await expect(anonPage.getByText('회수된 링크입니다')).toBeVisible()

  await anon.close()
})

test('없는 토큰은 404 — 링크를 찍어볼 수 없다', async ({ page, browser }) => {
  await loginAs(page, ACCOUNT) // 앱이 떠 있는 오리진을 알아내려고 로그인한다
  const origin = new URL(page.url()).origin

  const anon = await browser.newContext()
  expect((await anon.request.get(`${origin}/s/aaaaaaaaaaaaaaaaaaaaaa/meta`)).status()).toBe(404)
  await anon.close()
})
