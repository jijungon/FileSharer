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

test('하위 폴더의 파일을 이름으로 검색해 위치와 함께 찾고, 클릭하면 열린다', async ({ page }) => {
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
  // 방금 만든 폴더 아래 트리에 파일이 나타난다(하위 폴더에 들어가 있음)
  await expect(page.locator('.tree-name').filter({ hasText: fname })).toBeVisible()

  // 검색 → 결과에 파일 + 상위 경로(폴더명)
  await page.getByPlaceholder('이 공간에서 검색').fill(`찾을파일_${tag}`)
  const result = page.locator('.search-result', { hasText: fname })
  await expect(result).toBeVisible()
  await expect(result).toContainText(folder) // path 표시

  // 결과 클릭 → 검색 종료 + 파일 뷰어로 열림
  await result.click()
  await expect(page.locator('.search-results')).toHaveCount(0)
  await expect(page.locator('.viewer-area')).toBeVisible()
})

test('검색어를 비우면 검색 결과가 사라지고 목록으로 돌아온다', async ({ page }) => {
  await login(page)
  const box = page.getByPlaceholder('이 공간에서 검색')
  await box.fill('아무거나검색어xyz')
  await expect(page.locator('.search-results')).toBeVisible()
  await box.fill('')
  await expect(page.locator('.search-results')).toHaveCount(0)
  // 검색 해제 시 일반 탐색 화면(트리 안내)으로 돌아온다
  await expect(page.locator('.browser-welcome')).toBeVisible()
})
