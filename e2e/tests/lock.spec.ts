import { expect, request, test } from './fixtures'

const EMAIL = 'e2e@test.local'
const PASSWORD = 'e2e-password-123'

async function loginUI(page) {
  await page.goto('/login')
  await page.getByRole('button', { name: /로컬 계정으로 로그인/ }).click()
  await page.getByPlaceholder('이메일').fill(EMAIL)
  await page.getByPlaceholder('비밀번호').fill(PASSWORD)
  await page.getByRole('button', { name: '로컬 계정으로 로그인' }).click()
  await expect(page).toHaveURL(/\/files/)
}

// 동시 편집 방지(편집 잠금)의 UI 레벨 검증.
// 백엔드 API는 test_locks.py가 이미 커버하지만, "다른 사람이 편집 중이면 화면이 읽기 전용으로
// 바뀌는가"까지는 여기서 확인한다. B가 잠근 파일을 A가 열면 읽기 전용 배너 + 편집 불가.
test('다른 사람이 편집 중인 파일을 열면 읽기 전용 배너가 뜨고 편집이 막힌다', async ({
  page,
  baseURL,
}) => {
  await loginUI(page)

  // 관리자(A) 세션으로: 두 번째 사용자 B 생성 + 공용(org=전체) 공간에 MD 파일 생성
  const bEmail = `locker_${Date.now()}@test.local`
  const bPassword = 'pw-123456'
  const bNick = bEmail.split('@')[0]
  await page.request.post('/api/users', {
    data: { email: bEmail, password: bPassword, role: 'member' },
  })
  const spaces = await page.request.get('/api/spaces').then((r) => r.json())
  const org = spaces.find((s: { type: string }) => s.type === 'org')
  const fname = `잠금대상_${Date.now()}.md`
  const created = await page.request
    .post(`/api/spaces/${org.id}/files`, {
      multipart: {
        file: { name: fname, mimeType: 'text/markdown', buffer: Buffer.from('# lock test') },
      },
    })
    .then((r) => r.json())
  const fileId = Array.isArray(created) ? created[0].id : created.id

  // B가 별도 세션(API 컨텍스트)으로 그 파일의 편집 잠금을 잡는다 → 지금 B가 편집 중인 상태
  const bCtx = await request.newContext({ baseURL })
  await bCtx.post('/api/auth/login', { data: { email: bEmail, password: bPassword } })
  const bLock = await bCtx.post(`/api/nodes/${fileId}/lock`).then((r) => r.json())
  expect(bLock.held_by_me).toBe(true)

  // A가 같은 파일을 열면(딥링크) → 읽기 전용 배너 + CodeMirror 편집 불가
  await page.goto(`/files/${fileId}`)
  const banner = page.locator('.lock-banner')
  await expect(banner).toBeVisible()
  await expect(banner).toContainText(bNick) // holder = B의 이메일 닉네임
  await expect(banner).toContainText('읽기 전용')
  await expect(page.locator('.editor-pane .cm-content')).toHaveAttribute(
    'contenteditable',
    'false',
  )

  await bCtx.dispose()
})
