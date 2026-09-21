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

// '서버 업로드' 버튼은 title에도 문구가 겹칠 수 있어 '보이는 텍스트'로 특정한다.
async function openServerUpload(page) {
  await page.getByRole('button').filter({ hasText: '서버 업로드' }).first().click()
  await expect(page.getByRole('dialog', { name: '서버 업로드' })).toBeVisible()
}

test('임시 토큰 발급(버튼) → 한 토큰으로 여러 파일 Bearer 업로드 → 해제/회수', async ({ page }) => {
  await loginAsAdmin(page)

  // 관리 페이지 없이 서버 업로드 팝오버의 버튼 하나로 '임시 토큰'을 발급한다.
  await openServerUpload(page)
  await page.getByRole('button').filter({ hasText: '임시 토큰 발급' }).click()

  // 방금 발급한 토큰이 curl에 자동으로 채워진다 — 거기서 토큰과 엔드포인트를 읽어 온다.
  const curlCode = page.getByTestId('server-upload-curl')
  await expect(curlCode).toContainText('Bearer fsk_')
  const curl = ((await curlCode.textContent()) ?? '').trim()
  const token = curl.match(/Bearer (fsk_[^"]+)/)?.[1] ?? ''
  // 이제 curl은 /api/upload — 목적지는 토큰 범위가 정한다. 마지막 토큰이 엔드포인트 URL.
  const endpoint = curl.split(/\s+/).pop() ?? ''
  expect(token.startsWith('fsk_')).toBeTruthy()
  expect(endpoint).toContain('/api/upload')
  // 폴더째(tar → 서버 해제) 예시도 함께 노출된다.
  await expect(page.getByTestId('server-upload-tar')).toContainText('extract=tar')

  // 쿠키 없는 컨텍스트 = 순수 Bearer 인증. '같은 임시 토큰'으로 파일 여러 개를 연속 업로드.
  const api = await request.newContext({ baseURL: BASE })
  const stamp = Date.now()
  const names = [`e2e-a-${stamp}.log`, `e2e-b-${stamp}.log`, `e2e-c-${stamp}.log`]
  for (const name of names) {
    const res = await api.post(endpoint, {
      headers: { Authorization: `Bearer ${token}` },
      multipart: {
        file: { name, mimeType: 'text/plain', buffer: Buffer.from('pushed by temp token') },
      },
    })
    expect(res.status(), name).toBe(201) // 하나의 토큰으로 여러 번 성공(단일사용이 아님)
  }

  // '해제'하면 curl이 다시 <TOKEN> 자리표시자로 돌아간다(브라우저 메모리에서 비움).
  await page.getByRole('button', { name: '해제' }).click()
  await expect(page.getByTestId('server-upload-curl')).toContainText('<TOKEN>')

  // 외부 Bearer 업로드는 UI가 모르니 새로고침으로 트리를 최신화하고 파일들을 확인.
  await page.reload()
  for (const name of names) {
    await expect(fileCell(page, name)).toBeVisible()
  }

  // 파일을 열면 에디터 툴바에도 '서버 업로드' 버튼이 있다(폴더뷰뿐 아니라 파일뷰에도).
  await fileCell(page, names[0]).click()
  await expect(page.getByRole('button').filter({ hasText: '서버 업로드' })).toBeVisible()

  // 회수하면 같은 토큰의 업로드는 401 (방금 발급한 것 = 목록 최상단).
  const rows = await page.request.get('/api/tokens').then((r) => r.json())
  const tokenId = rows[0].id
  expect((await page.request.delete(`/api/tokens/${tokenId}`)).status()).toBe(200)
  const after = await api.post(endpoint, {
    headers: { Authorization: `Bearer ${token}` },
    multipart: {
      file: { name: 'should-fail.log', mimeType: 'text/plain', buffer: Buffer.from('x') },
    },
  })
  expect(after.status()).toBe(401)

  await api.dispose()
})
