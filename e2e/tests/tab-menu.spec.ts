import { ACCOUNT, expect, test } from './fixtures'

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

/** 파일 n개를 올리고 전부 열어 탭 n개를 만든다. 이름은 돌려준 순서가 곧 탭 순서다. */
async function openTabs(page, count: number): Promise<string[]> {
  const tag = Date.now()
  const names: string[] = []
  for (let i = 1; i <= count; i++) {
    const name = `탭${i}_${tag}.md`
    names.push(name)
    await page.locator('input[type="file"]:not([webkitdirectory])').setInputFiles({
      name,
      mimeType: 'text/markdown',
      buffer: Buffer.from(`# ${i}\n`),
    })
    await expect(page.locator('.tree-name').filter({ hasText: name })).toBeVisible()
    await page.locator('.tree-name').filter({ hasText: name }).click()
    await expect(page.locator('.tab').filter({ hasText: name })).toBeVisible()
  }
  await expect(page.locator('.tab')).toHaveCount(count)
  return names
}

function menu(page) {
  return page.getByRole('menu', { name: '탭' })
}

/** 탭을 여러 개 열어두면 ✕ 를 그 수만큼 눌러야 했다. 우클릭 한 번으로 끝내는 길. */
test('탭 우클릭: 모두 닫기', async ({ page }) => {
  await login(page)
  const names = await openTabs(page, 3)

  await page.locator('.tab').filter({ hasText: names[0] }).click({ button: 'right' })
  await expect(menu(page)).toBeVisible()

  await menu(page).getByRole('menuitem', { name: '모두 닫기', exact: true }).click()
  await expect(page.locator('.tab')).toHaveCount(0)
  await expect(menu(page)).toHaveCount(0)
})

test('탭 우클릭: 다른 탭 모두 닫기 — 누른 탭만 남는다', async ({ page }) => {
  await login(page)
  const names = await openTabs(page, 3)

  await page.locator('.tab').filter({ hasText: names[1] }).click({ button: 'right' })
  await menu(page).getByRole('menuitem', { name: '다른 탭 모두 닫기' }).click()

  await expect(page.locator('.tab')).toHaveCount(1)
  await expect(page.locator('.tab')).toContainText(names[1])
})

/** 못 누르는 항목은 **지우지 않고 흐리게** 둔다 — 메뉴 모양이 상황마다 달라지면
 *  같은 자리에 다른 것이 와서 잘못 누른다. */
test('탭 우클릭: 탭이 하나면 "다른 탭 모두 닫기" 가 눌리지 않는다', async ({ page }) => {
  await login(page)
  await openTabs(page, 1)

  await page.locator('.tab').first().click({ button: 'right' })
  const item = menu(page).getByRole('menuitem', { name: '다른 탭 모두 닫기' })
  await expect(item).toBeVisible() // 사라지지 않는다
  await expect(item).toBeDisabled()
})

test('탭 우클릭: 바깥을 누르거나 Esc 로 닫힌다', async ({ page }) => {
  await login(page)
  const names = await openTabs(page, 2)

  await page.locator('.tab').filter({ hasText: names[0] }).click({ button: 'right' })
  await expect(menu(page)).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(menu(page)).toHaveCount(0)

  await page.locator('.tab').filter({ hasText: names[0] }).click({ button: 'right' })
  await expect(menu(page)).toBeVisible()
  await page.locator('.topbar-search-input').click()
  await expect(menu(page)).toHaveCount(0)
  await expect(page.locator('.tab')).toHaveCount(2) // 닫기는 안 일어났다
})

/** 화면 가장자리에서 우클릭해도 메뉴가 **잘리지 않아야** 한다.
 *
 * 포인터 자리에 그대로 띄우면 오른쪽에서 절반이 화면 밖으로 나간다.
 *
 * **창을 충분히 좁혀야 한다.** 처음엔 넓은 창에서 탭 모서리를 눌렀는데, 거기선 메뉴가
 * 어차피 들어가서 보정을 꺼도 테스트가 통과했다 — 아무것도 지키지 못하는 테스트였다.
 * 메뉴 폭(180px)보다 오른쪽 여백이 좁아야 비로소 넘친다.
 */
test('탭 우클릭: 화면 가장자리에서도 메뉴가 잘리지 않는다', async ({ page }) => {
  await page.setViewportSize({ width: 520, height: 700 })
  await login(page)
  const names = await openTabs(page, 3)

  // 가장 오른쪽 탭의 오른쪽 끝 — 여기서 펼치면 메뉴가 화면 밖으로 나간다.
  // **스크롤은 직접, 즉시 끝낸다.** scrollIntoViewIfNeeded 는 부드럽게 움직일 수 있는데
  // 그 스크롤이 아직 흐르는 중에 우클릭하면 **메뉴가 열리자마자 그 스크롤에 닫힌다**
  // (탭 줄이 움직이면 메뉴가 가리키는 대상이 어긋나므로 닫는 게 맞다).
  const strip = page.locator('.tab-strip')
  await strip.evaluate((el) => {
    el.scrollLeft = el.scrollWidth
  })
  // **요소 기준으로, 그 안에서 가장 오른쪽을 누른다.**
  //  - 화면 좌표(page.mouse)로 짚었더니 탭이 스트립 가장자리에 걸려 잘린 부분을 가리켜
  //    클릭이 탭 밖에 떨어졌다(메뉴가 아예 안 떴다).
  //  - 그렇다고 가운데를 누르면 **보정을 꺼도 메뉴가 화면 안에 들어가** 아무것도
  //    지키지 못한다. 넘치는 건 오른쪽 끝에서 펼칠 때다.
  // position 은 요소 기준이라 Playwright 가 스크롤·레이아웃을 알아서 맞춘다.
  const tab = page.locator('.tab').filter({ hasText: names[2] })
  const box = await tab.boundingBox()
  await tab.click({ button: 'right', position: { x: box!.width - 4, y: box!.height / 2 } })
  await expect(menu(page)).toBeVisible()

  const geom = await menu(page).evaluate((el) => {
    const r = el.getBoundingClientRect()
    return {
      left: r.left,
      right: r.right,
      top: r.top,
      bottom: r.bottom,
      w: innerWidth,
      h: innerHeight,
    }
  })
  expect(geom.left, '왼쪽이 화면 밖').toBeGreaterThanOrEqual(0)
  expect(geom.top, '위쪽이 화면 밖').toBeGreaterThanOrEqual(0)
  expect(geom.right, `오른쪽이 화면 밖 (${geom.right} > ${geom.w})`).toBeLessThanOrEqual(geom.w)
  expect(geom.bottom, '아래쪽이 화면 밖').toBeLessThanOrEqual(geom.h)
})
