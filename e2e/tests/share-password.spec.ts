import { ACCOUNT, RUN_TAG, expect, loginAs, test } from './fixtures'

import { fileCell } from './helpers'

/**
 * 한글 비밀번호가 걸린 공유를 **화면에서** 열 수 있는가 — 회귀 테스트.
 *
 * HTTP 헤더 값은 Latin-1 만 담을 수 있다. 예전에는 비밀번호를 `X-Share-Password` 헤더에
 * 그대로 실었는데, 한글이면 브라우저가 요청을 **보내기도 전에** TypeError 를 던졌다
 * ("String contains non ISO-8859-1 code point"). 잡는 곳이 없어서 '열기' 버튼은
 * 아무 반응 없이 죽은 것처럼 보였다 — 에러 메시지도, 네트워크 요청도 없었다.
 *
 * 링크 만들기는 JSON 본문이라 멀쩡히 성공했고, 팝오버가 안내하는 `curl -u` 경로도
 * 동작했다. 그래서 **화면으로만** 조용히 못 여는 상태였다. 한국어 사내 도구에서
 * 한글 비밀번호는 오히려 자연스러운 선택이라 더 위험했다.
 *
 * 지금은 서버가 이미 받아주는 Basic 인증(base64 of UTF-8)으로 감싸 보낸다
 * (frontend/src/lib/sharepw.ts). 서버 쪽 계약은 backend/tests/test_shares.py 가 잡는다.
 */
test('한글 비밀번호가 걸린 공유를 화면에서 열 수 있다', async ({ page, browser }) => {
  const PW = '한글비밀번호'
  const name = `한글잠금_${RUN_TAG}.md`

  await loginAs(page, ACCOUNT)
  await page.locator('input[type="file"]:not([webkitdirectory])').setInputFiles({
    name,
    mimeType: 'text/markdown',
    buffer: Buffer.from('# 한글잠금\n\n비밀 내용\n'),
  })
  await expect(fileCell(page, name)).toBeVisible()

  await fileCell(page, name).click()
  // '공유 링크' 를 exact 로 찾는 이유: 주소창의 📋 버튼이 aria-label="사내 공유 링크 복사" 라
  // 부분 일치로 함께 잡힌다.
  await page.getByRole('button', { name: '공유 링크', exact: true }).click()
  await page.getByPlaceholder('없음').fill(PW)
  await page.getByRole('button', { name: '링크 만들기' }).click()

  const urlCode = page.locator('.share-copyrow code', {
    hasText: /^https?:\/\/\S+\/s\/[A-Za-z0-9_-]+$/,
  })
  await expect(urlCode).toBeVisible()
  const url = (await urlCode.textContent())!.trim()

  const anon = await browser.newContext()
  const anonPage = await anon.newPage()
  await anonPage.goto(url)
  await expect(anonPage.getByText('비밀번호가 걸린 공유입니다')).toBeVisible()

  // 틀리면 **말을 해줘야 한다**. 조용히 아무 일도 없으면 사용자는 오타인지 고장인지 모른다.
  await anonPage.getByPlaceholder('비밀번호').fill('틀린한글비번')
  await anonPage.getByRole('button', { name: '열기', exact: true }).click()
  await expect(anonPage.getByText('비밀번호가 올바르지 않습니다')).toBeVisible()
  await expect(anonPage.getByText('비밀 내용')).toHaveCount(0)

  // 맞으면 열린다 — 예전에는 여기서 영원히 멈춰 있었다.
  // exact 인 이유: 페이지 제목 <h2>📄 한글잠금_….md</h2> 와 본문 <h1>한글잠금</h1> 이 둘 다
  // '한글잠금' 을 품는다. 부분 일치로 두면 미리보기가 그려지기 '전'에만 통과하는,
  // 렌더 속도에 기대는 테스트가 된다 — 실제로 그렇게 한 번 터졌다. 본문 쪽을 집는다.
  await anonPage.getByPlaceholder('비밀번호').fill(PW)
  await anonPage.getByRole('button', { name: '열기', exact: true }).click()
  await expect(anonPage.getByRole('heading', { name: '한글잠금', exact: true })).toBeVisible()

  await anon.close()
})
