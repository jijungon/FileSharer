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

async function upload(
  page: import('@playwright/test').Page,
  name: string,
  body: string,
  mime = 'text/markdown',
) {
  await page.locator('input[type="file"]:not([webkitdirectory])').setInputFiles({
    name,
    mimeType: mime,
    buffer: Buffer.from(body),
  })
  await expect(fileCell(page, name)).toBeVisible()
}

/** 파일 하나를 올리고 공유 링크를 만들어 주소를 돌려준다. 팝오버는 열어 둔 채로 둔다. */
async function share(
  page: import('@playwright/test').Page,
  slug: string,
  opts: {
    password?: string
    maxDownloads?: number
    /** 기본은 `<slug>_<tag>.md`. 형식별 미리보기를 보려면 직접 준다. */
    name?: string
    body?: string
    mime?: string
  } = {},
) {
  const name = opts.name ?? `${slug}_${RUN_TAG}.md`
  await upload(page, name, opts.body ?? `# ${slug}\n\n비밀 내용\n`, opts.mime)
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

/** 공유 팝오버를 닫는다. 링크를 만들고 나면 폼이 '새 링크 더 만들기' 로 바뀌어서,
 *  닫지 않고 다음 파일을 공유하려 하면 '링크 만들기' 버튼을 못 찾는다. */
async function closeSharePopover(page: import('@playwright/test').Page) {
  await page.locator('.share-popover').getByRole('button', { name: /닫기/ }).click()
  await expect(page.locator('.share-popover')).toHaveCount(0)
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

test('공유 페이지가 HTML·코드·영상을 미리보기로 보여준다', async ({ page, browser }) => {
  // 예전엔 md·txt·이미지·PDF 만 보여주고 나머지는 "미리보기를 지원하지 않는 형식"이었다.
  // 앱 안 뷰어는 진작 보여주고 있었으니 같은 파일이 두 화면에서 다르게 보였다.
  await loginAs(page, ACCOUNT)

  const anon = await browser.newContext()

  // ① HTML — **격리해서** 보여준다. 심어둔 스크립트가 돌면 안 된다.
  const htmlUrl = await share(page, '리포트', {
    name: `리포트_${RUN_TAG}.html`,
    body: '<h1>공유된 리포트</h1><script>document.body.innerHTML="RAN"</script>',
    mime: 'application/octet-stream', // 업로더가 일반 mime 을 보내도 확장자로 되짚는다
  })
  await closeSharePopover(page)

  const htmlPage = await anon.newPage()
  await htmlPage.goto(htmlUrl)
  const frame = htmlPage.locator('iframe')
  await expect(frame).toHaveAttribute('sandbox', '')
  // sandbox 라 부모에서 안을 들여다볼 수 없다 — srcdoc 에 원문이 그대로 있는지로 확인한다
  await expect(frame).toHaveAttribute('srcdoc', /공유된 리포트/)
  await expect(htmlPage.getByText('미리보기를 지원하지 않는')).toHaveCount(0)

  // 서버도 같은 걸 막아준다(iframe 과 이중 방어) — 주소창에 /raw 를 직접 열어도 안전해야 한다
  const raw = await anon.request.get(`${htmlUrl}/raw`)
  expect(raw.headers()['content-security-policy']).toBe('sandbox')
  expect(raw.headers()['x-content-type-options']).toBe('nosniff')

  // ② 코드 — 마크다운이 아니라 코드블록으로. `#` 주석이 제목으로 잡히면 안 된다.
  const codeUrl = await share(page, '코드', {
    name: `설정_${RUN_TAG}.py`,
    body: 'def f():\n    return 1\n\n# 주석은 제목이 아니다\n',
    mime: 'application/octet-stream',
  })
  await closeSharePopover(page)

  const codePage = await anon.newPage()
  await codePage.goto(codeUrl)
  await expect(codePage.locator('pre code')).toContainText('def f():')
  await expect(codePage.locator('.share-toc')).toHaveCount(0) // 목차가 서면 안 된다

  // ③ 영상 — 통째로 받지 않고 주소를 직접 문다.
  //    원본(/raw)이 아니라 변환 경로다 — 브라우저가 못 읽는 오디오 코덱이면 서버가 AAC 로 바꾼다.
  const vidUrl = await share(page, '영상', {
    name: `영상_${RUN_TAG}.mp4`,
    body: '\u0000\u0000\u0000 ftypisom',
    mime: 'application/octet-stream',
  })
  await closeSharePopover(page)

  const vidPage = await anon.newPage()
  await vidPage.goto(vidUrl)
  await expect(vidPage.locator('video')).toHaveAttribute('src', /\/preview\.mp4$/)

  await anon.close()
})

test('공유된 오피스 문서도 미리보기 경로를 탄다 — 규칙을 우회하지 않는다', async ({
  page,
  browser,
}) => {
  // 오피스·한글은 서버가 LibreOffice 로 PDF 를 만들어 준다. **변환 자체는 이 환경에
  // 있을 수도 없을 수도 있어서** 결과물을 단언하지 않는다. 대신 중요한 것을 본다 —
  // 이 주소가 공유 링크 규칙(회수·비밀번호)을 **우회하는 뒷문이 되지 않는가.**
  await loginAs(page, ACCOUNT)
  const url = await share(page, '발표', {
    name: `발표_${RUN_TAG}.pptx`,
    body: 'dummy',
    mime: 'application/octet-stream',
  })

  const anon = await browser.newContext()

  // 오피스가 맞으니 "형식이 아니다"(400)는 아니어야 한다.
  // 변환이 되면 200(PDF), 변환기가 없으면 503(사유 포함) — 둘 다 정상이다.
  const ok = await anon.request.get(`${url}/preview.pdf`)
  expect([200, 503]).toContain(ok.status())
  if (ok.status() === 200) expect(ok.headers()['content-type']).toContain('application/pdf')

  // 회수하면 미리보기도 함께 죽는다 — 여기가 뚫리면 회수가 무의미해진다
  await closeSharePopover(page)
  await fileCell(page, `발표_${RUN_TAG}.pptx`).click()
  await page.getByRole('button', SHARE_BTN).click()
  const revoke = page.locator('.share-existing').getByRole('button', { name: '회수', exact: true })
  await revoke.click()
  await expect(revoke).toHaveCount(0)

  expect((await anon.request.get(`${url}/preview.pdf`)).status()).toBe(410)

  await anon.close()
})
