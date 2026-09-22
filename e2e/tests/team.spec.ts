import { expect, test } from './fixtures'

const EMAIL = 'e2e@test.local'
const PASSWORD = 'e2e-password-123'

async function loginAdmin(page) {
  await page.goto('/login')
  await page.getByRole('button', { name: /로컬 계정으로 로그인/ }).click()
  await page.getByPlaceholder('이메일').fill(EMAIL)
  await page.getByPlaceholder('비밀번호').fill(PASSWORD)
  await page.getByRole('button', { name: '로컬 계정으로 로그인' }).click()
  await expect(page).toHaveURL(/\/files/)
}

test('admin can create and delete a team', async ({ page }) => {
  await loginAdmin(page)
  await page.getByRole('button', { name: '관리' }).click()
  await page.getByRole('button', { name: '팀', exact: true }).click()

  // 고유 팀 이름 (반복 실행/공유 DB에서도 충돌 없게)
  const name = `E2E팀-${Date.now()}`
  await page.getByPlaceholder('팀 이름').fill(name)
  await page.getByRole('button', { name: '생성' }).click()

  // 팀 카드가 생겼다
  const card = page.locator('h3', { hasText: name })
  await expect(card).toBeVisible()

  // 삭제 (confirm 자동 수락) → 카드가 사라진다
  page.once('dialog', (d) => d.accept())
  await card.locator('..').getByRole('button', { name: '팀 삭제' }).click()
  await expect(page.locator('h3', { hasText: name })).toHaveCount(0)
})

test('force-delete a team that still has files', async ({ page }) => {
  await loginAdmin(page)

  // 팀 생성 + 본인 팀원 추가 + 팀 공간에 파일 업로드 (page.request = 같은 세션)
  const name = `강제E2E-${Date.now()}`
  const team = await (await page.request.post('/api/teams', { data: { name } })).json()
  const me = await (await page.request.get('/api/me')).json()
  await page.request.post(`/api/teams/${team.id}/members`, { data: { user_id: me.id } })
  const spaces = await (await page.request.get('/api/spaces')).json()
  const teamSpace = spaces.find((s: { type: string }) => s.type === 'team')
  await page.request.post(`/api/spaces/${teamSpace.id}/files`, {
    multipart: { file: { name: 'keep.txt', mimeType: 'text/plain', buffer: Buffer.from('data') } },
  })

  await page.getByRole('button', { name: '관리' }).click()
  await page.getByRole('button', { name: '팀', exact: true }).click()
  const card = page.locator('h3', { hasText: name })
  await expect(card).toBeVisible()

  // 두 번의 confirm(일반 삭제 → 409 → 강제 삭제)을 모두 수락
  page.on('dialog', (d) => d.accept())
  await card.locator('..').getByRole('button', { name: '팀 삭제' }).click()
  await expect(page.locator('h3', { hasText: name })).toHaveCount(0)
})
