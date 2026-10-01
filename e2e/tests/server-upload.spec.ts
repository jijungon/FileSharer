import { ACCOUNT, expect, request, test } from './fixtures'

import { fileCell } from './helpers'

const EMAIL = ACCOUNT.email
const PASSWORD = ACCOUNT.password
const BASE = process.env.BASE_URL ?? 'http://localhost:8484'

async function loginAsAdmin(page) {
  await page.goto('/login')
  await page.getByRole('button', { name: /로컬 계정으로 로그인/ }).click()
  await page.getByPlaceholder('이메일').fill(EMAIL)
  await page.getByPlaceholder('비밀번호').fill(PASSWORD)
  await page.getByRole('button', { name: '로컬 계정으로 로그인' }).click()
  await expect(page).toHaveURL(/\/files/)
}

// 버튼은 업로드/다운로드를 함께 다루므로 이름이 '서버'가 됐고, 팝오버는 '서버 전송'이다.
// 탭 줄에선 **아이콘만** 보이고 글자는 화면에서만 접혀 있다. hasText 는 눈에 보이는 글자를
// 보므로 그 버튼을 못 찾는다 — 접근성 이름으로 집어야 사람이 부르는 이름과 같은 걸 집는다.
const serverButton = (page) => page.getByRole('button', { name: '서버', exact: true })

async function openServerUpload(page) {
  await serverButton(page).click()
  await expect(page.getByRole('dialog', { name: '서버 전송' })).toBeVisible()
}

test('임시 토큰 발급(버튼) → 한 토큰으로 여러 파일 Bearer 업로드 → 해제/회수', async ({ page }) => {
  await loginAsAdmin(page)

  // 관리 페이지 없이 서버 업로드 팝오버의 버튼 하나로 '임시 토큰'을 발급한다.
  await openServerUpload(page)
  await page.getByRole('button').filter({ hasText: '임시 토큰 발급' }).click()

  // 방금 발급한 토큰이 curl에 자동으로 채워진다 — 거기서 토큰과 엔드포인트를 읽어 온다.
  const curlCode = page.getByTestId('server-upload-curl')
  await expect(curlCode).toContainText('Bearer fsk_')
  const curl = ((await curlCode.textContent()) ?? '').trim()
  const token = curl.match(/Bearer (fsk_[^"]+)/)?.[1] ?? ''
  // 이제 curl은 /api/upload — 목적지는 토큰 범위가 정한다. 마지막 토큰이 엔드포인트 URL.
  const endpoint = curl.split(/\s+/).pop() ?? ''
  expect(token.startsWith('fsk_')).toBeTruthy()
  expect(endpoint).toContain('/api/upload')
  // 폴더째(tar → 서버 해제) 예시도 함께 노출된다.
  await expect(page.getByTestId('server-upload-tar')).toContainText('extract=tar')

  // 쿠키 없는 컨텍스트 = 순수 Bearer 인증. '같은 임시 토큰'으로 파일 여러 개를 연속 업로드.
  const api = await request.newContext({ baseURL: BASE })
  const stamp = Date.now()
  const names = [`e2e-a-${stamp}.log`, `e2e-b-${stamp}.log`, `e2e-c-${stamp}.log`]
  for (const name of names) {
    const res = await api.post(endpoint, {
      headers: { Authorization: `Bearer ${token}` },
      multipart: {
        file: { name, mimeType: 'text/plain', buffer: Buffer.from('pushed by temp token') },
      },
    })
    expect(res.status(), name).toBe(201) // 하나의 토큰으로 여러 번 성공(단일사용이 아님)
  }

  // '해제'하면 curl이 다시 <TOKEN> 자리표시자로 돌아간다(브라우저 메모리에서 비움).
  // 팝오버로 범위를 좁힌다 — 트리의 '즐겨찾기 해제' 별표 버튼과 이름이 겹쳐(부분일치) 오탐되지 않게.
  await page.locator('.share-popover').getByRole('button', { name: '해제', exact: true }).click()
  await expect(page.getByTestId('server-upload-curl')).toContainText('<TOKEN>')

  // 외부 Bearer 업로드는 UI가 모르니 새로고침으로 트리를 최신화하고 파일들을 확인.
  await page.reload()
  for (const name of names) {
    await expect(fileCell(page, name)).toBeVisible()
  }

  // 파일을 열면 상단 액션에도 '서버' 버튼이 있다(폴더뷰뿐 아니라 파일뷰에도).
  await fileCell(page, names[0]).click()
  await expect(serverButton(page)).toBeVisible()

  // 같은 토큰으로 '내려받기' 명령도 제공된다(filesharer → 원격지). 공개 링크 없이 헤더 인증.
  await openServerUpload(page)
  // 다운로드는 대상에 따라 파일/폴더로 바뀐다 — 지금 안 보이는 쪽이 있다는 안내가 있어야 한다
  await expect(page.getByTestId('server-download-hint')).toContainText('폴더를 고르거나')
  const dl = page.getByTestId('server-download-curl')
  await expect(dl).toContainText('Authorization: Bearer')
  await expect(dl).toContainText('/api/files/')
  await page.locator('.share-popover').getByRole('button', { name: /닫기/ }).click()

  // 회수하면 같은 토큰의 업로드는 401 (방금 발급한 것 = 목록 최상단).
  const rows = await page.request.get('/api/tokens').then((r) => r.json())
  const tokenId = rows[0].id
  expect((await page.request.delete(`/api/tokens/${tokenId}`)).status()).toBe(200)
  const after = await api.post(endpoint, {
    headers: { Authorization: `Bearer ${token}` },
    multipart: {
      file: { name: 'should-fail.log', mimeType: 'text/plain', buffer: Buffer.from('x') },
    },
  })
  expect(after.status()).toBe(401)

  await api.dispose()
})

// 팝오버가 자기 상자 밖으로 새어 나가지 않는지 — 눈으로만 보이던 깨짐을 숫자로 잡는다.
//
// 액션을 탭 줄로 내리면서 `.tab-actions { white-space: nowrap }` 를 넣었는데(안 그러면
// '자동저장'이 '자/동/저/장'으로 세로로 쪼개진다), 그게 팝오버 안 설명 문단까지 상속돼
// 한 줄로 뻗어 나갔다 — 913px 가 필요한 문단이 440px 상자 안에 들어앉았다.
// 거기에 팝오버는 top:56px(상단 바 시절 좌표)로 자기 버튼이 있는 탭 줄을 덮고 있었고,
// 기준 조상이 뷰어 개폐에 따라 바뀌어 화면 밖으로도 밀려났다.
// 기존 테스트는 전부 통과했다 — 버튼이 '보이기는' 했으니까.
//
// 그래서 보이는지가 아니라 **어디까지 차지하는지**를 본다.
test('서버 전송 팝오버는 탭 줄 아래에 붙고, 내용이 상자 밖으로 새지 않는다', async ({ page }) => {
  await loginAsAdmin(page)
  await page.setViewportSize({ width: 1280, height: 800 })
  await openServerUpload(page)

  const geom = await page.evaluate(() => {
    const pop = document.querySelector('.share-popover') as HTMLElement
    const bar = document.querySelector('.tab-bar') as HTMLElement
    const r = pop.getBoundingClientRect()
    const spill = [...pop.querySelectorAll('*')]
      .map((e) => ({ cls: String((e as HTMLElement).className).slice(0, 24), right: e.getBoundingClientRect().right }))
      .filter((x) => x.right > r.right + 1)
      .map((x) => x.cls)
    return {
      left: r.left, right: r.right, top: r.top, bottom: r.bottom,
      barBottom: bar.getBoundingClientRect().bottom,
      whiteSpace: getComputedStyle(pop).whiteSpace,
      spill,
      pageScrollsSideways: document.documentElement.scrollWidth > window.innerWidth,
    }
  })

  // 1) 자기 버튼이 있는 줄 **아래**에 뜬다 — 예전엔 top:56px 고정이라 탭 줄을 덮었다
  expect(geom.top).toBeGreaterThanOrEqual(geom.barBottom)
  // 2) 탭 줄의 nowrap 이 팝오버까지 따라 들어오지 않는다
  expect(geom.whiteSpace).toBe('normal')
  // 3) 아무것도 상자 밖으로 안 나간다
  expect(geom.spill).toEqual([])
  // 4) 화면 안에 들어온다 — 가로로 끌어야 보이면 안 된다
  expect(geom.right).toBeLessThanOrEqual(1280)
  expect(geom.left).toBeGreaterThanOrEqual(0)
  expect(geom.pageScrollsSideways).toBe(false)
})
