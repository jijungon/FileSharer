import { expect, test } from './fixtures'
import { newFolder } from './helpers'

const EMAIL = 'e2e@test.local'
const PASSWORD = 'e2e-password-123'

test('sidebar folder tree navigates into folders and back to root', async ({ page }) => {
  await page.goto('/login')
  await page.getByRole('button', { name: /로컬 계정으로 로그인/ }).click()
  await page.getByPlaceholder('이메일').fill(EMAIL)
  await page.getByPlaceholder('비밀번호').fill(PASSWORD)
  await page.getByRole('button', { name: '로컬 계정으로 로그인' }).click()
  await expect(page).toHaveURL(/\/files/)

  const parent = `트리부모-${Date.now()}`

  // 루트에 폴더 생성
  await newFolder(page, parent)

  // 사이드바 트리에 폴더가 나타난다 → 클릭해 들어가기
  const treeItem = page.locator('.tree-name', { hasText: parent })
  await expect(treeItem).toBeVisible()
  await treeItem.click()

  // 브레드크럼을 없앴으므로(상단 주소창으로 통합), 트리에서 그 폴더가 '현재 폴더'로 활성 표시되는지로 확인
  await expect(page.locator('.tree-row.active', { hasText: parent })).toBeVisible()
  await expect(page).toHaveURL(/\/files\/.+/)

  // 하위 폴더 생성 → 트리에서 부모 아래에 나타남
  const child = `트리자식-${Date.now()}`
  await newFolder(page, child)
  const childInTree = page.locator('.tree-name', { hasText: child })
  await expect(childInTree).toBeVisible()

  // 트리에서 자식 폴더로 진입 → 자식이 현재 폴더로 활성 표시된다
  await childInTree.click()
  await expect(page.locator('.tree-row.active', { hasText: child })).toBeVisible()

  // 트리에서 부모 폴더를 눌러 한 단계 위(부모)로 복귀 (브레드크럼 대체)
  await page.locator('.tree-name', { hasText: parent }).first().click()
  await expect(page.locator('.tree-row.active', { hasText: parent })).toBeVisible()
  await expect(page.locator('.tree-row.active', { hasText: child })).toHaveCount(0)

  // 공간 루트(사이드바의 활성 공간)를 눌러 최상위로 복귀
  await page.locator('.space-item.space-root.active').click()
  await expect(page).toHaveURL(/\/files$/)
})

test('트리에서 파일을 고르고 Enter를 누르면 제자리에서 이름을 바꾼다', async ({ page }) => {
  await page.goto('/login')
  await page.getByRole('button', { name: /로컬 계정으로 로그인/ }).click()
  await page.getByPlaceholder('이메일').fill(EMAIL)
  await page.getByPlaceholder('비밀번호').fill(PASSWORD)
  await page.getByRole('button', { name: '로컬 계정으로 로그인' }).click()
  await expect(page).toHaveURL(/\/files/)

  const tag = Date.now()
  const fname = `이름변경_${tag}.txt`
  const newName = `바뀐이름_${tag}.txt`
  await page.locator('input[type="file"]:not([webkitdirectory])').setInputFiles({
    name: fname,
    mimeType: 'text/plain',
    buffer: Buffer.from('x'),
  })
  await expect(page.locator('.upload-row')).toHaveCount(0)
  const item = page.locator('.tree-name').filter({ hasText: fname })
  await expect(item).toBeVisible()

  // 파일 선택(포커스) → Enter → 제자리 입력창 → 새 이름 입력 → Enter로 커밋
  await item.click()
  await item.press('Enter')
  const input = page.locator('.tree-rename-input')
  await expect(input).toBeVisible()
  await input.fill(newName)
  await input.press('Enter')

  // 트리에 새 이름이 나타나고 옛 이름은 사라진다(제자리 편집, prompt 팝업 없음)
  await expect(page.locator('.tree-name').filter({ hasText: newName })).toBeVisible()
  await expect(page.locator('.tree-name').filter({ hasText: fname })).toHaveCount(0)
})

test('열린 파일을 리네임하면 탭·주소창 이름도 함께 갱신된다', async ({ page }) => {
  await page.goto('/login')
  await page.getByRole('button', { name: /로컬 계정으로 로그인/ }).click()
  await page.getByPlaceholder('이메일').fill(EMAIL)
  await page.getByPlaceholder('비밀번호').fill(PASSWORD)
  await page.getByRole('button', { name: '로컬 계정으로 로그인' }).click()
  await expect(page).toHaveURL(/\/files/)

  const tag = Date.now()
  const fname = `열림리네임_${tag}.md`
  const newName = `열림새이름_${tag}`
  await page.locator('input[type="file"]:not([webkitdirectory])').setInputFiles({
    name: fname,
    mimeType: 'text/markdown',
    buffer: Buffer.from('# hi'),
  })
  await expect(page.locator('.upload-row')).toHaveCount(0)

  // 파일을 연다 → 탭·주소창(경로)에 현재 이름이 뜬다
  const item = page.locator('.tree-name').filter({ hasText: fname })
  await item.click()
  const box = page.getByPlaceholder('파일 이름·내용 검색')
  await expect(page.locator('.tab-name').filter({ hasText: fname })).toBeVisible()
  await expect(box).toHaveValue(new RegExp(fname.replace(/[.]/g, '\\.')))

  // 트리에서 제자리 리네임 → 열린 탭과 주소창도 새 이름으로 갱신되어야 한다
  await item.click()
  await item.press('Enter')
  const input = page.locator('.tree-rename-input')
  await expect(input).toBeVisible()
  await input.fill(newName)
  await input.press('Enter')

  await expect(page.locator('.tab-name').filter({ hasText: newName })).toBeVisible()
  await expect(box).toHaveValue(new RegExp(newName))
  // 옛 이름은 탭에서 사라진다
  await expect(page.locator('.tab-name').filter({ hasText: fname })).toHaveCount(0)
})
