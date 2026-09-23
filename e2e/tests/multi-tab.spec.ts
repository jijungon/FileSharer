import { expect, test } from './fixtures'

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

async function upload(page, name: string, body: string) {
  await page.locator('input[type="file"]:not([webkitdirectory])').setInputFiles({
    name,
    mimeType: 'text/markdown',
    buffer: Buffer.from(body),
  })
  await expect(page.locator('.upload-row')).toHaveCount(0)
  await expect(page.locator('.tree-name').filter({ hasText: name })).toBeVisible()
}

test('여러 파일을 열면 탭으로 쌓이고, 전환·닫기가 동작한다', async ({ page }) => {
  await login(page)
  const tag = Date.now()
  const a = `탭A_${tag}.md`
  const b = `탭B_${tag}.md`
  await upload(page, a, '# A 문서')
  await upload(page, b, '# B 문서')

  // A 열기 → 탭 1개(A) 활성
  await page.locator('.tree-name').filter({ hasText: a }).click()
  await expect(page.locator('.tab')).toHaveCount(1)
  await expect(page.locator('.tab.active .tab-name')).toHaveText(a)

  // B 열기 → 탭 2개, B 활성(마지막에 연 것)
  await page.locator('.tree-name').filter({ hasText: b }).click()
  await expect(page.locator('.tab')).toHaveCount(2)
  await expect(page.locator('.tab.active .tab-name')).toHaveText(b)

  // A 탭 클릭 → A 활성(전환)
  await page.locator('.tab', { hasText: a }).click()
  await expect(page.locator('.tab.active .tab-name')).toHaveText(a)

  // B 탭 닫기(✕) → 탭 1개(A)만 남고 A 활성 유지
  await page.locator('.tab', { hasText: b }).locator('.tab-close').click()
  await expect(page.locator('.tab')).toHaveCount(1)
  await expect(page.locator('.tab.active .tab-name')).toHaveText(a)
})

test('편집하면 그 탭에 미저장(●) 표시가 붙는다', async ({ page }) => {
  await login(page)
  const tag = Date.now()
  const name = `수정_${tag}.md`
  await upload(page, name, '# 처음 내용')

  await page.locator('.tree-name').filter({ hasText: name }).click()
  await expect(page.locator('.tab.active .tab-name')).toHaveText(name)
  // 아직 저장 안 건드림 → dirty 아님
  await expect(page.locator('.tab.active')).not.toHaveClass(/dirty/)

  // 편집기에 입력 → 그 탭이 dirty(●)
  const editor = page.locator('.viewer-area .cm-content')
  await expect(editor).toBeVisible()
  await editor.click()
  await page.keyboard.type(' 추가 편집')
  await expect(page.locator('.tab.active')).toHaveClass(/dirty/)
  await expect(page.locator('.tab.active .tab-close-dot')).toBeVisible()
})
