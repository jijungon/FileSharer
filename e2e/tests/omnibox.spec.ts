import { expect, test } from './fixtures'
import { fileCell } from './helpers'

const EMAIL = 'e2e@test.local'
const PASSWORD = 'e2e-password-123'

async function login(page) {
  await page.goto('/login')
  await page.getByRole('button', { name: /로컬 계정으로 로그인/ }).click()
  await page.getByPlaceholder('이메일').fill(EMAIL)
  await page.getByPlaceholder('비밀번호').fill(PASSWORD)
  await page.getByRole('button', { name: '로컬 계정으로 로그인' }).click()
  await expect(page).toHaveURL(/\/files/)
}

// 상단 검색창은 크롬식 '주소창(오미니박스)'을 겸한다.
// 파일을 열면 그 파일의 경로가 뜨고(주소 모드) 📋로 사내 공유 링크를 복사한다.
// 타이핑하면 검색 모드로 바뀌고, 결과를 고르면 다시 주소(경로) 모드로 돌아온다.
test('상단 주소창: 파일을 열면 경로가 뜨고 📋가 생기며, 타이핑하면 검색 모드로 바뀐다', async ({
  page,
}) => {
  await login(page)

  const fname = `주소창_${Date.now()}.txt`
  await page.locator('input[type="file"]:not([webkitdirectory])').setInputFiles({
    name: fname,
    mimeType: 'text/plain',
    buffer: Buffer.from('omnibox'),
  })
  await expect(page.locator('.upload-row')).toHaveCount(0)

  // 파일을 연다 → 검색창이 '주소 모드'가 되어 경로(내 공간/파일명)를 보여준다
  await fileCell(page, fname).click()
  const box = page.getByPlaceholder('파일 이름·내용 검색')
  await expect(page.locator('.topbar-search.is-address')).toBeVisible()
  await expect(box).toHaveValue(new RegExp(fname.replace(/[.]/g, '\\.')))
  // 사내 공유 링크 복사 버튼(📋)이 주소창 안에 있다
  await expect(page.locator('.topbar-search-copy')).toBeVisible()

  // 타이핑하면 검색 모드로 전환 — 주소 틴트가 사라지고 결과 드롭다운이 뜬다
  await box.click()
  await box.fill('주소창')
  await expect(page.locator('.topbar-search.is-address')).toHaveCount(0)
  await expect(page.locator('.topbar-search-results')).toBeVisible()

  // 결과를 고르면 그 파일이 열리고 주소창은 다시 경로 모드로 돌아온다
  await page.locator('.search-result', { hasText: fname }).first().click()
  await expect(page.locator('.topbar-search.is-address')).toBeVisible()
  await expect(box).toHaveValue(new RegExp(fname.replace(/[.]/g, '\\.')))
})
