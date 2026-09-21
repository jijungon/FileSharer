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

  // 우측 API 토큰 드로어를 열고 UI로 발급
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

  // 방금 발급한 토큰이 '서버 업로드' 팝오버 curl에 자동 채워진다(드로어 닫고 확인)
  await page.getByRole('button', { name: 'API 토큰' }).click() // 드로어 토글로 닫기
  await page.getByRole('button', { name: /서버 업로드/ }).click()
  await expect(page.locator('.share-popover code').filter({ hasText: 'Bearer' })).toContainText(
    token,
  )
  await page.locator('.share-popover').getByRole('button', { name: /닫기/ }).click()

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

  // 파일이 실제로 그 공간 트리에 생겼는지(업로더=토큰 소유자) — UI에서도 확인.
  // 드로어는 오버레이라 새로고침으로 닫고 트리를 최신화한다(외부 Bearer 업로드는 UI가 모름).
  await page.reload()
  await expect(fileCell(page, uploadName)).toBeVisible()

  // 파일을 열면 에디터 툴바에도 '서버 업로드' 버튼이 있다(폴더뷰뿐 아니라 파일뷰에도)
  await fileCell(page, uploadName).click()
  await expect(page.getByRole('button', { name: /서버 업로드/ })).toBeVisible()

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
