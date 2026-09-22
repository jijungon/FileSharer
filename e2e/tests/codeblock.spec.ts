import { expect, test } from './fixtures'

import { fileCell } from './helpers'

const EMAIL = 'e2e@test.local'
const PASSWORD = 'e2e-password-123'

async function loginAsAdmin(page) {
  await page.goto('/login')
  await page.getByRole('button', { name: /로컬 계정으로 로그인/ }).click()
  await page.getByPlaceholder('이메일').fill(EMAIL)
  await page.getByPlaceholder('비밀번호').fill(PASSWORD)
  await page.getByRole('button', { name: '로컬 계정으로 로그인' }).click()
  await expect(page).toHaveURL(/\/files/)
}

// 과거 버그: 어두운 코드 타일에 라이트 하이라이트 테마를 써서 코드블록 글자가
// 배경에 묻혀 안 보였다(대비 ≈ 1). jsdom은 색을 계산 못 하므로, 실제 헤드리스
// 브라우저에서 렌더된 글자색·배경색의 WCAG 대비를 계산해 가독성을 보장한다.
test('마크다운 코드블록 글자가 배경과 충분한 대비로 보인다', async ({ page }) => {
  await loginAsAdmin(page)

  const md = '# 코드\n\n```js\nconst secret = 42\nconsole.log(secret)\n```\n'
  await page.locator('input[type="file"]:not([webkitdirectory])').setInputFiles({
    name: '코드블록.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from(md),
  })
  await fileCell(page, /코드블록\.md/).click()

  const code = page.locator('.md-preview pre code')
  await expect(code).toBeVisible()
  await expect(code).toContainText('const')

  const contrast = await code.evaluate((el) => {
    const parse = (c: string) => {
      const m = c.match(/rgba?\(([^)]+)\)/)
      return m ? m[1].split(',').slice(0, 3).map((n) => parseFloat(n)) : [0, 0, 0]
    }
    const lum = ([r, g, b]: number[]) => {
      const f = (v: number) => {
        const x = v / 255
        return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4
      }
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
    }
    // 위로 올라가며 투명하지 않은 첫 배경색을 코드블록 배경으로 사용
    let node: HTMLElement | null = el as HTMLElement
    let bg = 'rgb(255, 255, 255)'
    while (node) {
      const c = getComputedStyle(node).backgroundColor
      if (c && c !== 'transparent' && !/,\s*0\)\s*$/.test(c)) {
        bg = c
        break
      }
      node = node.parentElement
    }
    const L1 = lum(parse(getComputedStyle(el).color)) + 0.05
    const L2 = lum(parse(bg)) + 0.05
    return Math.max(L1, L2) / Math.min(L1, L2)
  })

  // 버그면 ≈1, 정상(다크 테마)이면 크게 상회. 3.0 은 둘을 확실히 가른다.
  expect(contrast).toBeGreaterThan(3)
})
