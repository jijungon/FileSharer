import { expect, test } from './fixtures'
import { newFolder } from './helpers'

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

// 검색은 이제 사이드바가 아니라 '상단 바'에 있고, 이름 + 내용(텍스트) 둘 다로 찾는다.
test('상단 검색: 하위 폴더의 파일을 이름으로 찾아 위치와 함께 보여주고, 클릭하면 열린다', async ({
  page,
}) => {
  await login(page)
  const tag = Date.now()
  const folder = `검색폴더_${tag}`
  const fname = `찾을파일_${tag}.txt`

  // 폴더 생성 → 트리에서 진입 → 그 안에 파일 업로드
  await newFolder(page, folder)
  const folderItem = page.locator('.tree-name').filter({ hasText: folder })
  await expect(folderItem).toBeVisible()
  await folderItem.click()
  await expect(page.locator('.crumb-current, .crumb', { hasText: folder })).toBeVisible()
  await page.locator('input[type="file"]:not([webkitdirectory])').setInputFiles({
    name: fname,
    mimeType: 'text/plain',
    buffer: Buffer.from('hello'),
  })
  await expect(page.locator('.upload-row')).toHaveCount(0)
  await expect(page.locator('.tree-name').filter({ hasText: fname })).toBeVisible()

  // 상단 검색 → 결과 드롭다운에 파일 + 상위 경로(폴더명)
  await page.getByPlaceholder('파일 이름·내용 검색').fill(`찾을파일_${tag}`)
  const result = page.locator('.topbar-search-results .search-result', { hasText: fname })
  await expect(result).toBeVisible()
  await expect(result).toContainText(folder) // path 표시

  // 결과 클릭 → 검색 종료 + 파일 뷰어로 열림
  await result.click()
  await expect(page.locator('.topbar-search-results')).toHaveCount(0)
  await expect(page.locator('.viewer-area')).toBeVisible()
})

test('상단 검색: 이름에 없어도 파일 내용(텍스트)으로 찾고 "내용" 뱃지를 보여준다', async ({
  page,
}) => {
  await login(page)
  const tag = Date.now()
  const fname = `무관한제목_${tag}.md` // 이름엔 검색어가 없음
  const token = `내용전용토큰${tag}` // 오직 내용에만 있는 문자열

  await page.locator('input[type="file"]:not([webkitdirectory])').setInputFiles({
    name: fname,
    mimeType: 'text/markdown',
    buffer: Buffer.from(`# 문서\n\n여기 어딘가에 ${token} 가 들어있다.\n`),
  })
  await expect(page.locator('.upload-row')).toHaveCount(0)
  await expect(page.locator('.tree-name').filter({ hasText: fname })).toBeVisible()

  // 내용에만 있는 토큰으로 검색 → 그 파일이 '내용' 매치로 뜬다
  await page.getByPlaceholder('파일 이름·내용 검색').fill(token)
  const result = page.locator('.topbar-search-results .search-result', { hasText: fname })
  await expect(result).toBeVisible()
  await expect(result.locator('.search-match-badge')).toHaveText('내용')
})

test('상단 검색: 검색어를 비우면 결과 드롭다운이 사라진다', async ({ page }) => {
  await login(page)
  const box = page.getByPlaceholder('파일 이름·내용 검색')
  await box.fill('아무거나검색어xyz')
  await expect(page.locator('.topbar-search-results')).toBeVisible()
  await box.fill('')
  await expect(page.locator('.topbar-search-results')).toHaveCount(0)
  // 검색과 무관하게 탐색 화면은 그대로(사이드바 트리 안내)
  await expect(page.locator('.browser-welcome')).toBeVisible()
})

test('사이드바에는 더 이상 검색창·최근이 없다(상단 검색으로 대체, 탭이 최근 대체)', async ({
  page,
}) => {
  await login(page)
  await expect(page.locator('.sidebar-search')).toHaveCount(0)
  await expect(page.locator('.recent-inline, .recent-item')).toHaveCount(0)
  await expect(page.locator('.topbar-search-input')).toBeVisible()
})

test('상단 검색: 사내 링크(해시)를 붙여넣으면 그 파일이 결과로 뜬다', async ({ page }) => {
  await login(page)
  const tag = Date.now()
  const fname = `링크파일_${tag}.txt`
  await page.locator('input[type="file"]:not([webkitdirectory])').setInputFiles({
    name: fname,
    mimeType: 'text/plain',
    buffer: Buffer.from('link me'),
  })
  await expect(page.locator('.upload-row')).toHaveCount(0)

  // 파일을 열어 URL에서 해시(node id)를 얻는다
  await page.locator('.tree-name').filter({ hasText: fname }).click()
  await expect(page).toHaveURL(/\/files\/[0-9a-f]{32}/)
  const id = page.url().match(/\/files\/([0-9a-f]{32})/)![1]

  // 검색창에 사내 링크(전체 URL)를 붙여넣으면 이름검색이 아니라 그 파일로 해석돼 결과에 뜬다
  await page.getByPlaceholder('파일 이름·내용 검색').fill(`https://file.example/files/${id}`)
  const result = page.locator('.topbar-search-results .search-result', { hasText: fname })
  await expect(result).toBeVisible()
})

test('상단 검색: 화살표로 결과를 고르고 Enter로 연다', async ({ page }) => {
  await login(page)
  const tag = Date.now()
  for (const n of [`고르기${tag}가.txt`, `고르기${tag}나.txt`]) {
    await page.locator('input[type="file"]:not([webkitdirectory])').setInputFiles({
      name: n,
      mimeType: 'text/plain',
      buffer: Buffer.from('x'),
    })
    await expect(page.locator('.upload-row')).toHaveCount(0)
  }

  const box = page.getByPlaceholder('파일 이름·내용 검색')
  await box.click()
  await box.fill(`고르기${tag}`)
  await expect(page.locator('.topbar-search-results .search-result')).toHaveCount(2)

  // ↓ 로 결과를 하이라이트하고, Enter 로 그 결과를 연다
  await box.press('ArrowDown')
  const picked = await page.locator('.search-result.active .search-result-name').textContent()
  await box.press('Enter')
  await expect(page.locator('.topbar-search-results')).toHaveCount(0) // 드롭다운 닫힘
  await expect(page.locator('.tab.active .tab-name')).toHaveText(picked!) // 그 파일이 탭으로 열림
})

test('상단 검색: 검색창 바깥을 클릭하면 드롭다운이 닫힌다', async ({ page }) => {
  await login(page)
  const box = page.getByPlaceholder('파일 이름·내용 검색')
  await box.click()
  await box.fill('아무거나검색xyz')
  await expect(page.locator('.topbar-search-results')).toBeVisible()
  // 검색창 바깥(로고)을 클릭 → 드롭다운이 닫힌다
  await page.locator('.logo').click()
  await expect(page.locator('.topbar-search-results')).toHaveCount(0)
})

test('상단 검색: 경로처럼 입력해도(공간/폴더/파일명) 마지막 파일명으로 찾는다', async ({ page }) => {
  await login(page)
  const tag = Date.now()
  const fname = `경로검색_${tag}.txt`
  await page.locator('input[type="file"]:not([webkitdirectory])').setInputFiles({
    name: fname,
    mimeType: 'text/plain',
    buffer: Buffer.from('x'),
  })
  await expect(page.locator('.upload-row')).toHaveCount(0)

  // '내 공간/경로검색_TAG.txt' 처럼 경로로 입력해도 마지막 조각(파일명)으로 찾아진다
  await page.getByPlaceholder('파일 이름·내용 검색').fill(`내 공간/${fname}`)
  const result = page.locator('.topbar-search-results .search-result', { hasText: fname })
  await expect(result).toBeVisible()
})

test('상단 검색: 다른 공간에 있는 파일도 찾는다(모든 공간 검색)', async ({ page }) => {
  await login(page)
  const tag = Date.now()
  const fname = `타공간_${tag}.txt`
  // 현재(기본) 공간에 파일 업로드
  await page.locator('input[type="file"]:not([webkitdirectory])').setInputFiles({
    name: fname,
    mimeType: 'text/plain',
    buffer: Buffer.from('x'),
  })
  await expect(page.locator('.tree-name').filter({ hasText: fname })).toBeVisible()

  // 다른 공간으로 전환한 뒤 검색해도 방금 올린(원래 공간의) 파일이 잡힌다
  await page.locator('.space-root:not(.active)').first().click()
  await page.getByPlaceholder('파일 이름·내용 검색').fill(fname)
  await expect(
    page.locator('.topbar-search-results .search-result', { hasText: fname }),
  ).toBeVisible()
})
