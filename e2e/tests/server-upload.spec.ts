import { expect, request, test } from '@playwright/test'

import { fileCell } from './helpers'

const EMAIL = 'e2e@test.local'
const PASSWORD = 'e2e-password-123'
const BASE = process.env.BASE_URL ?? 'http://localhost:8484'

async function loginAsAdmin(page) {
  await page.goto('/login')
  await page.getByRole('button', { name: /로컬 계정으로 로그인/ }).click()
  await page.getByPlaceholder('이메일').fill(EMAIL)
  await page.getByPlaceholder('비밀번호').fill(PASSWORD)
  await page.getByRole('button', { name: '로컬 계정으로 로그인' }).click()
  await expect(page).toHaveURL(/\/files/)
}

test('API 토큰 발급 → Bearer 업로드 → 회수(401) 전체 흐름', async ({ page }) => {
  await loginAsAdmin(page)

  // 개인 공간 id (업로드 대상 URL 구성용) — 로그인 세션 쿠키로 조회
  const spaces = await page.request.get('/api/spaces').then((r) => r.json())
  const personalId = spaces.find((s: { type: string }) => s.type === 'personal').id

  // 토큰 관리 화면으로 이동해 UI로 발급
  await page.getByRole('button', { name: 'API 토큰' }).click()
  await expect(page.getByRole('heading', { name: 'API 토큰' })).toBeVisible()

  const label = `e2e-token-${Date.now()}`
  await page.getByPlaceholder(/라벨/).fill(label)
  await page.getByRole('button', { name: '발급' }).click()

  // 원문은 발급 직후 한 번만 노출된다 — 화면에서 읽어 온다
  const tokenValue = page.getByTestId('token-value')
  await expect(tokenValue).toBeVisible()
  const token = ((await tokenValue.textContent()) ?? '').trim()
  expect(token.startsWith('fsk_')).toBeTruthy()

  // 쿠키 없는 컨텍스트 = 순수 토큰(Bearer) 인증만으로 업로드되는지 증명
  const api = await request.newContext({ baseURL: BASE })
  const uploadName = `e2e-server-upload-${Date.now()}.log`
  const ok = await api.post(`/api/spaces/${personalId}/files`, {
    headers: { Authorization: `Bearer ${token}` },
    multipart: {
      file: { name: uploadName, mimeType: 'text/plain', buffer: Buffer.from('pushed by token') },
    },
  })
  expect(ok.status()).toBe(201)

  // 파일이 실제로 그 공간 트리에 생겼는지(업로더=토큰 소유자) — UI에서도 확인
  await page.getByRole('link', { name: /파일로 돌아가기/ }).click()
  await expect(page).toHaveURL(/\/files/)
  await expect(fileCell(page, uploadName)).toBeVisible()

  // 회수 후 같은 토큰으로 재업로드하면 401
  const tokenId = await page.request
    .get('/api/tokens')
    .then((r) => r.json())
    .then((rows) => rows.find((t: { label: string }) => t.label === label).id)
  const revoked = await page.request.delete(`/api/tokens/${tokenId}`)
  expect(revoked.status()).toBe(200)

  const after = await api.post(`/api/spaces/${personalId}/files`, {
    headers: { Authorization: `Bearer ${token}` },
    multipart: {
      file: { name: 'should-fail.log', mimeType: 'text/plain', buffer: Buffer.from('x') },
    },
  })
  expect(after.status()).toBe(401)

  await api.dispose()
})
