import { expect, test } from './fixtures'

/** 소스맵이 공개 주소로 새지 않나.
 *
 * 소스맵에는 **원본 코드가 통째로** 들어 있다. file.rgrg.im 은 누구나 열 수 있는 주소라,
 * 번들 옆에 .map 을 같이 실으면 주석 한 줄만 따라가면 전부 받아갈 수 있다.
 *
 * 그렇다고 안 만들 수도 없다 — 안 만들면 Sentry 에 찍히는 스택이 `t.a is not a function`
 * 같은 압축된 글자라 읽을 수가 없다. 그래서 **만들되, 이미지엔 넣지 않고 Sentry 에만**
 * 올린다(Dockerfile 의 sourcemaps 스테이지).
 *
 * 지켜야 할 게 둘이라 둘 다 본다. `vite.config.ts` 의 sourcemap 을 'hidden' 에서 true 로
 * 바꾸면 주석이 돌아오고, Dockerfile 의 `find -delete` 를 지우면 파일이 돌아온다.
 */
test('소스맵이 공개 주소로 새지 않는다', async ({ page }) => {
  const html = await (await page.request.get('/')).text()
  const assets = [...html.matchAll(/\/assets\/[A-Za-z0-9._-]+\.js/g)].map((m) => m[0])
  expect(assets.length, 'index.html 에서 번들 주소를 못 찾았다').toBeGreaterThan(0)

  for (const asset of assets) {
    const res = await page.request.get(asset)
    expect(res.status(), `${asset} 를 못 받았다`).toBe(200)

    // ① 번들이 맵의 위치를 가리키면 안 된다
    expect(
      await res.text(),
      `${asset} 에 sourceMappingURL 주석이 남아 있다 — vite 의 sourcemap 을 'hidden' 으로`,
    ).not.toContain('sourceMappingURL')

    // ② 주석이 없어도 주소를 찍어보면 그만이다. 파일 자체가 없어야 한다.
    //    (SPA 라 없는 주소는 index.html 로 떨어진다 — 그래서 '맵인가'로 본다)
    const map = await page.request.get(`${asset}.map`)
    const body = map.ok() ? await map.text() : ''
    expect(
      map.ok() && body.includes('"sources"'),
      `${asset}.map 을 받을 수 있다 — 원본 코드가 공개된다`,
    ).toBe(false)
  }
})
