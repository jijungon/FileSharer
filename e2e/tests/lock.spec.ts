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

// org(전체) 공간 루트에 MD 파일을 하나 만들고 {id, name}을 돌려준다 — 삭제 경합 테스트 공용 헬퍼.
async function createOrgFile(page, content: string): Promise<{ id: string; name: string }> {
  const spaces = await page.request.get('/api/spaces').then((r) => r.json())
  const org = spaces.find((s: { type: string }) => s.type === 'org')
  const name = `삭제경합_${Date.now()}.md`
  const created = await page.request
    .post(`/api/spaces/${org.id}/files`, {
      multipart: { file: { name, mimeType: 'text/markdown', buffer: Buffer.from(content) } },
    })
    .then((r) => r.json())
  return { id: Array.isArray(created) ? created[0].id : created.id, name }
}

// 이 파일에 대한 '잠금 획득' POST(/nodes/{id}/lock)만 세는 리스너를 단다. 해제(/lock/release)는 제외.
function countLockPosts(page, fileId: string): { get: () => number } {
  let n = 0
  page.on('request', (req) => {
    if (req.method() === 'POST' && req.url().endsWith(`/api/nodes/${fileId}/lock`)) n += 1
  })
  return { get: () => n }
}

// 열린 파일이 '외부에서'(다른 세션·API·e2e reset) 삭제됐을 때의 견고성.
// 과거 버그: 삭제된 노드의 편집기가 하트비트로 /lock 을 404로 수백 번 POST(다중 탭이 비활성 편집기도
// 계속 마운트해 둠). 이제 404를 종료 상태로 다뤄 하트비트를 멈추고, 미저장이 아니면 탭을 닫는다.
test('열린 파일이 외부에서 삭제되면 잠금 요청이 폭주하지 않고(감지 후 탭이 닫힌다)', async ({
  page,
}) => {
  await loginUI(page)
  const { id: fileId, name } = await createOrgFile(page, '# delete race')
  const locks = countLockPosts(page, fileId)

  // 파일을 열면 편집기가 뜨고 최초 잠금 1회(정상).
  await page.goto(`/files/${fileId}`)
  await expect(page.locator('.editor-pane .cm-content')).toBeVisible()
  await expect.poll(() => locks.get()).toBeGreaterThanOrEqual(1)
  const afterOpen = locks.get()

  // 다른 경로(관리자 세션 API DELETE)로 그 노드를 휴지통으로 보낸다 — 편집기는 그대로 열려 있음.
  const del = await page.request.delete(`/api/nodes/${fileId}`)
  expect(del.ok()).toBeTruthy()

  // 삭제가 하트비트로 감지되면(최대 10초) 미저장이 아니라 탭이 자동으로 닫힌다 → 편집기도 사라짐.
  await expect(page.locator('.tab', { hasText: name })).toHaveCount(0, { timeout: 15_000 })
  await expect(page.locator('.editor-pane')).toHaveCount(0)

  // 그 사이 잠금 POST는 '폭주'하지 않는다(감지용 1회 안팎). 회귀하면 수백 건이 되어 여기서 잡힌다.
  expect(locks.get() - afterOpen).toBeLessThanOrEqual(2)
})

// 미저장 상태에서 외부 삭제되면: 데이터 보호를 위해 탭은 남기되 '삭제됨' 배너 + 읽기 전용으로 굳고,
// 역시 하트비트가 멈춰 /lock 요청이 폭주하지 않는다.
test('미저장 파일이 외부에서 삭제되면 탭은 남고 삭제됨 배너 + 읽기전용 (잠금 폭주 없음)', async ({
  page,
}) => {
  await loginUI(page)
  const { id: fileId, name } = await createOrgFile(page, '# keep my edits')
  const locks = countLockPosts(page, fileId)

  await page.goto(`/files/${fileId}`)
  const editor = page.locator('.editor-pane .cm-content')
  await expect(editor).toBeVisible()
  await expect(editor).toHaveAttribute('contenteditable', 'true') // 내가 잠금 보유 → 편집 가능
  await expect.poll(() => locks.get()).toBeGreaterThanOrEqual(1)
  const afterOpen = locks.get()

  // 미저장 변경을 만든다 → 탭에 ● (dirty) 표시.
  await editor.click()
  await page.keyboard.type(' 편집중')
  await expect(page.locator('.tab.dirty', { hasText: name })).toBeVisible()

  // 외부에서 삭제.
  const del = await page.request.delete(`/api/nodes/${fileId}`)
  expect(del.ok()).toBeTruthy()

  // 삭제 감지(≤10초): 탭은 남고(미저장 보호), '삭제됨' 배너 + 읽기 전용으로 굳는다.
  await expect(page.locator('.lock-banner.deleted')).toBeVisible({ timeout: 15_000 })
  await expect(page.locator('.tab', { hasText: name })).toHaveCount(1)
  await expect(editor).toHaveAttribute('contenteditable', 'false')

  // 하트비트가 멈춰 잠금 POST는 폭주하지 않는다.
  expect(locks.get() - afterOpen).toBeLessThanOrEqual(2)
})
