import { RUN_TAG, expect, test } from './fixtures'

import { fileCell } from './helpers'

// 공유 자원(전체 공간·팀·사용자 목록·member 계정)을 건드리므로 파일 안에서는 직렬.
// playwright.config.ts 의 'shared' 프로젝트가 solo 가 끝난 뒤에 이 파일들을 돌린다.
test.describe.configure({ mode: 'serial' })

/**
 * 일반 사용자(member) 시점.
 *
 * **왜 이 파일이 생겼나**: 지금까지 e2e 53개가 전부 관리자로 돌았다. 그래서 "관리자에게만
 * 보이도록" 걸어둔 조건이 일반 사용자를 막고 있어도 테스트는 초록이었다 — 실제로 마지막
 * 백업 뱃지가 그렇게 막혀 있었고, 사용자가 세 번 말해주고서야 알았다.
 *
 * 두 방향을 같이 본다.
 *   · 관리 기능이 **새지 않는가** (보안)
 *   · 공용 기능이 **막히지 않았는가** (오늘의 사고)
 */

test('일반 사용자에게 관리 기능이 새지 않는다', async ({ memberPage }) => {
  await expect(memberPage.getByRole('button', { name: '관리' })).toHaveCount(0)

  // 주소를 직접 쳐도 들어가지지 않는다
  await memberPage.goto('/admin')
  await expect(memberPage).toHaveURL(/\/files/)

  // 화면만 막고 API가 열려 있으면 막은 게 아니다 (관리 라우터 prefix 는 /api)
  const res = await memberPage.request.get('/api/users')
  expect(res.status()).toBe(403)
})

test('관리자에게는 관리 버튼이 보인다 (위 검증이 헛돌지 않게)', async ({ page }) => {
  const { loginAs, ADMIN } = await import('./fixtures')
  await loginAs(page, ADMIN)
  await expect(page.getByRole('button', { name: '관리' })).toBeVisible()
})

test('마지막 백업 뱃지는 일반 사용자에게도 보인다', async ({ memberPage }) => {
  // 오늘의 사고 그 자체. "내 파일이 언제 백업됐나"는 관리자만의 관심사가 아니다.
  const badge = memberPage.locator('.backup-badge')
  await expect(badge).toBeVisible()

  // CI에는 백업이 없으니 '없음'이 정상 — 중요한 건 **뱃지가 사라지지 않는 것**이다.
  await expect(badge).toHaveText(/⛁/)

  const res = await memberPage.request.get('/api/system/backup')
  expect(res.status()).toBe(200)
  const body = await res.json()
  // 규모(공간·파일 수·용량)는 자기가 못 보는 공간의 크기를 드러내므로 관리자에게만
  if (body.last) {
    expect(body.last).not.toHaveProperty('files')
    expect(body.last).not.toHaveProperty('bytes')
  }
})

test('일반 사용자도 올리고 열고 공유할 수 있다', async ({ memberPage }) => {
  await memberPage.locator('input[type="file"]:not([webkitdirectory])').setInputFiles({
    name: `사용자문서_${RUN_TAG}.md`,
    mimeType: 'text/markdown',
    buffer: Buffer.from('# 일반 사용자 문서\n\n본문입니다.\n'),
  })

  await fileCell(memberPage, `사용자문서_${RUN_TAG}.md`).click()
  await expect(memberPage.getByRole('heading', { name: '일반 사용자 문서' })).toBeVisible()

  await memberPage.getByRole('button', { name: '공유 링크', exact: true }).click()
  await memberPage.getByRole('button', { name: '링크 만들기' }).click()
  await expect(
    memberPage.locator('.share-copyrow code', {
      hasText: /^https?:\/\/\S+\/s\/[A-Za-z0-9_-]+$/,
    }),
  ).toBeVisible()
})

test('일반 사용자에게도 서버 전송이 열려 있다', async ({ memberPage }) => {
  // 토큰은 '자기 범위 안에서만' 동작하므로 일반 사용자에게 막을 이유가 없다.
  await memberPage.getByRole('button', { name: /서버/ }).click()
  await expect(memberPage.getByRole('dialog', { name: '서버 전송' })).toBeVisible()
  await expect(memberPage.getByTestId('server-upload-curl')).toBeVisible()
})
