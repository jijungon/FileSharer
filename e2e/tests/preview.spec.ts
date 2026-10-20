import { forEachTheme } from './a11y'
import { ACCOUNT, RUN_TAG, expect, test } from './fixtures'

import { fileCell, newMd } from './helpers'

const EMAIL = ACCOUNT.email
const PASSWORD = ACCOUNT.password
// 1x1 투명 PNG
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
)

async function loginAsAdmin(page) {
  await page.goto('/login')
  await page.getByRole('button', { name: /로컬 계정으로 로그인/ }).click()
  await page.getByPlaceholder('이메일').fill(EMAIL)
  await page.getByPlaceholder('비밀번호').fill(PASSWORD)
  await page.getByRole('button', { name: '로컬 계정으로 로그인' }).click()
  await expect(page).toHaveURL(/\/files/)
}

test('image preview renders inline', async ({ page }) => {
  await loginAsAdmin(page)
  await page.locator('input[type="file"]:not([webkitdirectory])').setInputFiles({
    name: `픽셀_${RUN_TAG}.png`,
    mimeType: 'image/png',
    buffer: PNG,
  })
  await fileCell(page, `픽셀_${RUN_TAG}.png`).click()
  await expect(page.locator('.image-preview img')).toBeVisible()
})

test('new MD: modal opens, save creates the file and opens it', async ({ page }) => {
  await loginAsAdmin(page)
  await newMd(page, '회의록')

  // 편집 모달이 뜬다(아직 파일 생성 안 됨) — 에디터 + 프리뷰
  const modal = page.locator('.new-md-modal')
  await expect(modal).toBeVisible()
  await expect(modal.locator('.cm-content')).toBeVisible()
  await expect(modal.locator('.md-preview').getByRole('heading', { name: '회의록' })).toBeVisible()

  // 저장 → 모달 닫히고, 만든 파일이 에디터로 열린다(VS Code식 3분할: 목록 대신 편집기가 뜸)
  await modal.getByRole('button', { name: '저장' }).click()
  await expect(modal).toBeHidden()
  await expect(page.locator('.tab.active .tab-name')).toContainText('회의록')
})

test('new MD: cancel discards without creating a file', async ({ page }) => {
  await loginAsAdmin(page)
  await newMd(page, '버리는문서')
  const modal = page.locator('.new-md-modal')
  await expect(modal).toBeVisible()
  await modal.getByRole('button', { name: '취소' }).click()
  await expect(modal).toBeHidden()
  // 파일이 생성되지 않았다(트리에도 없음)
  await expect(page.locator('.tree-name').filter({ hasText: /버리는문서\.md/ })).toHaveCount(0)
})

/** 새 문서 모달의 편집기도 **테마를 따라가야** 한다.
 *
 * 테마가 본 편집기(ViewerPanel)에만 걸려 있어서, 모달 편집기는 CodeMirror 기본(흰 바탕)
 * 으로 뜨고 다크 모드의 밝은 글자색만 물려받았다 — **흰 바탕에 연한 회색 글씨**라 쓴 글이
 * 안 보였다. "편집기가 보이나" 로는 못 잡는다(보이긴 했다). **대비를 재야** 잡힌다.
 */
test('new MD: 모달 편집기 글씨가 라이트·다크 모두에서 읽힌다', async ({ page }) => {
  await loginAsAdmin(page)
  await newMd(page, '대비확인')
  const modal = page.locator('.new-md-modal')
  await expect(modal.locator('.cm-content')).toBeVisible()
  await modal.locator('.cm-content').click()
  await page.keyboard.type('여기 쓴 글이 보여야 한다')

  await forEachTheme(page, async (theme) => {
    // 테마가 바뀐 뒤 편집기가 다시 그려질 틈을 준다
    await expect
      .poll(() => page.evaluate(() => document.documentElement.dataset.theme))
      .toBe(theme)
    const ratio = await modal.evaluate((root) => {
      const rgb = (c: string) => (c.match(/[\d.]+/g) || []).map(Number)
      const lum = ([r, g, b]: number[]) => {
        const f = (v: number) => {
          v /= 255
          return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
        }
        return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
      }
      const line = root.querySelector('.cm-line') as HTMLElement
      const fg = rgb(getComputedStyle(line).color)
      // 투명하지 않은 첫 배경을 위로 올라가며 찾는다
      let el: HTMLElement | null = line
      let bg = [255, 255, 255]
      while (el) {
        const c = getComputedStyle(el).backgroundColor
        const v = rgb(c)
        if (v.length >= 3 && (v.length < 4 || v[3] > 0) && c !== 'transparent') {
          bg = v.slice(0, 3)
          break
        }
        el = el.parentElement
      }
      const [a, b] = [lum(fg), lum(bg)].sort((x, y) => y - x)
      return (a + 0.05) / (b + 0.05)
    })
    expect(ratio, `${theme}: 편집기 글씨 대비 ${ratio.toFixed(2)} — 4.5 이상이어야 읽힌다`).toBeGreaterThanOrEqual(4.5)
  })
})
