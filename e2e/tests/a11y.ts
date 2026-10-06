import AxeBuilder from '@axe-core/playwright'
import { expect } from './fixtures'

/** 접근성 자동 검사.
 *
 * **왜 이게 필요한가**: 지금 e2e 는 "버튼이 있나"(`toBeVisible`)를 본다. 그런데
 * `visibility: hidden` 은 요소를 **접근성 트리에서 지우고** 탭 순서에서도 빼는데,
 * Playwright 로는 그대로 '보인다'. v1.0.4 에서 '회수'·'닫기' 버튼이 그렇게 사라졌고,
 * 테스트 70개가 전부 통과한 채로 배포됐다. 사람이 화면을 보고서야 알았다.
 *
 * axe 는 그걸 기계가 읽는 쪽(접근성 트리·색 대비·레이블)에서 본다.
 *
 * **serious·critical 에서만 실패시킨다.** moderate 는 랜드마크·제목 구조 같은 것이라
 * 고치면 좋지만 기능을 막지는 않는다. 그걸로 PR 을 세우면 사람들이 검사를 꺼버린다.
 */
export async function expectAccessible(page, opts: { label?: string } = {}) {
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze()

  const blocking = result.violations.filter(
    (v) => v.impact === 'serious' || v.impact === 'critical',
  )
  const report = blocking
    .map((v) => `  [${v.impact}] ${v.id} — ${v.help}\n    ${v.nodes.map((n) => n.html.slice(0, 120)).join('\n    ')}`)
    .join('\n')

  expect(blocking, `${opts.label ?? page.url()} 접근성 위반:\n${report}`).toEqual([])
}

/** 떠 있는 패널이 자기 상자 안에 들어 있나.
 *
 * `toBeVisible()` 은 글자가 상자를 뚫고 나가도, 패널이 화면 밖에 있어도 참이다.
 * v1.0.7 에서 팝오버 글이 913px 로 뻗어 나가고 위치가 좌우로 튀었는데, e2e 91개가
 * 전부 통과했다. **"보이나" 가 아니라 "어디까지 차지하나" 를 봐야 잡힌다.**
 */
export async function expectContained(page, selector: string, label: string) {
  const geom = await page.evaluate((sel) => {
    const box = document.querySelector(sel) as HTMLElement | null
    if (!box) return null
    const r = box.getBoundingClientRect()

    // **자손의 위치로는 못 잡는다.** 이 상자엔 overflow-y:auto 가 있고, 그러면 CSS 규칙상
    // overflow-x 도 auto 가 되어 **넘친 자손을 잘라낸다** — 잘린 자손의 right 는 상자
    // 안쪽으로 보고된다. 실제로 그렇게 짰다가 버그를 되살려도 통과했다.
    //
    // 진짜 신호는 **내용이 제 상자보다 넓은가**(scrollWidth > clientWidth) 다.
    // 단, code·pre 는 **일부러** 가로로 스크롤한다(긴 curl 한 줄은 접으면 뜻이 바뀐다).
    const overflowing = [...box.querySelectorAll('p, div, span, label, dd, dt, li, h1, h2, h3')]
      .filter((e) => !e.closest('code, pre'))
      .filter((e) => e.scrollWidth > e.clientWidth + 2)
      .map((e) => {
        const el = e as HTMLElement
        return `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 20)}(${e.scrollWidth}>${e.clientWidth})`
      })

    return {
      left: r.left,
      right: r.right,
      top: r.top,
      spill: overflowing,
      viewportW: window.innerWidth,
      sideways: document.documentElement.scrollWidth > window.innerWidth,
    }
  }, selector)

  expect(geom, `${label}: ${selector} 를 못 찾음`).not.toBeNull()
  expect(geom!.spill, `${label}: 글이 제 상자보다 넓다 — ${geom!.spill.join(', ')}`).toEqual([])
  expect(geom!.left, `${label}: 왼쪽이 화면 밖`).toBeGreaterThanOrEqual(0)
  expect(geom!.right, `${label}: 오른쪽이 화면 밖`).toBeLessThanOrEqual(geom!.viewportW)
  expect(geom!.sideways, `${label}: 페이지를 가로로 끌어야 보임`).toBe(false)
}


/** 라이트·다크 양쪽에서 검사한다.
 *
 * 테마마다 색이 다르니 **대비 문제도 한쪽에만 생긴다.** 실제로 빈 화면 안내문의
 * 대비가 다크에서만 기준에 모자랐는데, 라이트만 보는 테스트는 그걸 통과시켰다.
 * (테마는 <html data-theme> 가 단일 진실이고 localStorage 에 기억한다 — lib/theme.ts)
 */
export async function forEachTheme(page, fn: (theme: 'light' | 'dark') => Promise<void>) {
  // **색이 바뀌는 도중을 재면 안 된다.** 이걸 빼놨다가 다크에서 '대비 2.21' 이라는
  // 실패를 받았는데, 그 배경색(#716f6b)은 토큰 어디에도 없는 값이었다 — 라이트 배경
  // (#ece9e5)에서 다크 배경(#24231e)으로 62% 쯤 건너간 중간값, 즉 `.space-item` 의
  // `transition: background .15s` 가 **아직 건너는 중** 인 화면이었다. 글자색은 전환
  // 대상이 아니라 즉시 바뀌니, 새 글자색이 잠깐 옛 배경 위에 놓인다.
  // 가라앉은 뒤의 실제 대비는 6.96 로 멀쩡하다.
  //
  // 기다려도(waitForTimeout) 되지만 느리고 언젠가 또 아슬아슬해진다. 전환을 꺼버리면
  // **언제 재든 같은 값** 이 나온다. 앱이 이미 가진 길을 쓴다 — styles.css 의
  // `@media (prefers-reduced-motion: reduce)`.
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.addStyleTag({
    content: '*, *::before, *::after { transition: none !important; animation: none !important }',
  })

  for (const theme of ['light', 'dark'] as const) {
    await page.evaluate((t) => {
      document.documentElement.setAttribute('data-theme', t)
      try {
        localStorage.setItem('fs:theme', t)
      } catch {
        /* 사생활 보호 모드 — 이번 세션만 적용된다 */
      }
    }, theme)
    await fn(theme)
  }
}
