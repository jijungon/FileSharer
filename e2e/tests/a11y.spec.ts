import { ACCOUNT, expect, test } from './fixtures'
import { expectAccessible, expectContained, forEachTheme } from './a11y'

const EMAIL = ACCOUNT.email
const PASSWORD = ACCOUNT.password

async function login(page) {
  await page.goto('/login')
  await page.getByRole('button', { name: /로컬 계정으로 로그인/ }).click()
  await page.getByPlaceholder('이메일').fill(EMAIL)
  await page.getByPlaceholder('비밀번호').fill(PASSWORD)
  await page.getByRole('button', { name: '로컬 계정으로 로그인' }).click()
  await expect(page).toHaveURL(/\/files/)
}

test('접근성: 로그인 화면 (라이트·다크)', async ({ page }) => {
  await page.goto('/login')
  await page.getByRole('button', { name: /로컬 계정으로 로그인/ }).click()
  await forEachTheme(page, (t) => expectAccessible(page, { label: `로그인 (${t})` }))
})

test('접근성: 파일 화면 (라이트·다크)', async ({ page }) => {
  await login(page)
  await forEachTheme(page, (t) => expectAccessible(page, { label: `파일 목록 (${t})` }))
})

test('접근성: CLI 안내 · CLI 로그인 승인 (라이트·다크)', async ({ page }) => {
  await login(page)
  await page.goto('/cli')
  await expect(page.getByRole('heading', { name: /CLI/ })).toBeVisible()
  await forEachTheme(page, (t) => expectAccessible(page, { label: `/cli (${t})` }))

  await page.goto('/device')
  await expect(page.getByLabel('터미널에 뜬 코드')).toBeVisible()
  await forEachTheme(page, (t) => expectAccessible(page, { label: `/device (${t})` }))
})

test('기하: 서버 전송 팝오버가 자기 상자 안에 들어 있다', async ({ page }) => {
  // v1.0.7 에서 글이 913px 로 뻗어 나가고 위치가 좌우로 튀었는데 e2e 91개가 전부
  // 통과했다. 좁은 창에서 특히 잘 터지는 자리라 두 폭에서 본다.
  await login(page)
  for (const width of [1280, 900]) {
    await page.setViewportSize({ width, height: 800 })
    await page.getByRole('button', { name: '서버', exact: true }).click()
    await expect(page.locator('.share-popover')).toBeVisible()
    await expectContained(page, '.share-popover', `서버 전송 팝오버 ${width}px`)
    await page.locator('.share-popover').getByRole('button', { name: /닫기/ }).click()
  }
})

test('기하: 탭 줄의 버튼이 전부 화면 안에 있다', async ({ page }) => {
  // v1.0.7 에서 탭 두 개만 열어도 둘째 탭의 ✕ 가 경계에 걸려 눌리지 않았다.
  await login(page)
  await page.setViewportSize({ width: 1280, height: 800 })
  for (const name of ['가.md', '나.md']) {
    await page.locator('input[type="file"]:not([webkitdirectory])').setInputFiles({
      name,
      mimeType: 'text/markdown',
      buffer: Buffer.from(`# ${name}`),
    })
    await page.locator('.tree-name', { hasText: name }).first().click()
  }
  await expect(page.locator('.tab')).toHaveCount(2)

  const off = await page.evaluate(() => {
    const vw = window.innerWidth
    return [...document.querySelectorAll('.tab-bar button')]
      .map((b) => ({ t: (b.textContent || b.getAttribute('aria-label') || '?').trim().slice(0, 12), r: b.getBoundingClientRect() }))
      .filter((x) => x.r.width > 0 && (x.r.right > vw + 1 || x.r.left < -1))
      .map((x) => x.t)
  })
  expect(off, `화면 밖으로 밀린 버튼: ${off.join(', ')}`).toEqual([])
})

/** 앱 껍데기 **밖** 의 페이지에서 갇히지 않나.
 *
 * axe 는 이걸 못 잡는다 — 대비도 레이블도 멀쩡하고, 다만 **나갈 문이 없을** 뿐이다.
 * /cli 는 사이드바도 탭 줄도 없이 혼자 뜨는데 돌아가는 링크가 없어서, 브라우저
 * 뒤로가기를 쓰지 않는 사람은 그 화면에 머물렀다. 사람이 쓰다가 말해줘서 알았다.
 */
for (const [path, label] of [
  ['/cli', 'CLI 안내'],
  ['/device', 'CLI 로그인 승인'],
] as const) {
  test(`갇히지 않는다: ${label} 에서 파일로 돌아갈 수 있다`, async ({ page }) => {
    await login(page)
    await page.goto(path)

    const back = page.getByRole('link', { name: /파일로 돌아가기/ })
    await expect(back, `${path} 에 돌아가는 길이 없다`).toBeVisible()
    await back.click()
    await expect(page).toHaveURL(/\/files/)
  })
}
