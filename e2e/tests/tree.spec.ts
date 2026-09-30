import { ACCOUNT, expect, loginAs, test } from './fixtures'
import { newFolder } from './helpers'

const EMAIL = ACCOUNT.email
const PASSWORD = ACCOUNT.password

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

test('우클릭해도 메뉴가 뜨지 않는다 — 하나를 고르든 여럿을 고르든', async ({ page }) => {
  // 트리 우클릭 메뉴를 통째로 없앴다. 단건이 하던 일은 행에서 바로 할 수 있고
  // (★ 즐겨찾기 · 🗑 휴지통 · 선택 후 Enter 이름 변경), 여러 개를 골랐을 때 하던 일은
  // 하단 선택 바에 그대로 있다(내려받기 · 삭제 · 선택 해제).
  // 없앴다는 걸 고정해 두지 않으면 나중에 슬그머니 돌아온다.
  await loginAs(page, ACCOUNT)
  const tag = Date.now()
  const names = [1, 2].map((i) => `우클릭없음${i}_${tag}.txt`)
  await page
    .locator('input[type="file"]:not([webkitdirectory])')
    .setInputFiles(names.map((n) => ({ name: n, mimeType: 'text/plain', buffer: Buffer.from('x') })))
  const first = page.locator('.tree-name').filter({ hasText: names[0] })
  const second = page.locator('.tree-name').filter({ hasText: names[1] })
  await expect(second).toBeVisible()

  // ① 아무것도 안 고른 상태
  await first.click({ button: 'right' })
  await expect(page.locator('.tree-menu')).toHaveCount(0)

  // ② 여러 개를 고른 상태 — 예전엔 여기서 대량 메뉴가 떴다
  await first.click({ modifiers: ['ControlOrMeta'] })
  await second.click({ modifiers: ['ControlOrMeta'] })
  await expect(page.locator('.bulk-bar')).toContainText('2개 선택됨')
  await first.click({ button: 'right' })
  await expect(page.locator('.tree-menu')).toHaveCount(0)

  // 대신 하단 바에 전부 있다
  const bar = page.locator('.bulk-bar')
  await expect(bar.getByRole('button', { name: '내려받기' })).toBeVisible()
  await expect(bar.getByRole('button', { name: '삭제' })).toBeVisible()
  await expect(bar.getByRole('button', { name: '선택 해제' })).toBeVisible()

  // 행에서 바로 되는 것들도 살아 있어야 한다
  const row = page.locator('.tree-row').filter({ has: first })
  await expect(row.getByRole('button', { name: '즐겨찾기', exact: true })).toBeAttached()
  await expect(row.getByRole('button', { name: '휴지통으로 이동' })).toBeAttached()
})
