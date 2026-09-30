import { ACCOUNT, RUN_TAG, expect, test } from './fixtures'

import { fileCell } from './helpers'

// 공유 자원(전체 공간·팀·사용자 목록·member 계정)을 건드리므로 파일 안에서는 직렬.
// playwright.config.ts 의 'shared' 프로젝트가 solo 가 끝난 뒤에 이 파일들을 돌린다.
test.describe.configure({ mode: 'serial' })

test('admin system tab: disk, audit log, trash manager', async ({ page }) => {
  await page.goto('/login')
  await page.getByRole('button', { name: /로컬 계정으로 로그인/ }).click()
  await page.getByPlaceholder('이메일').fill(ACCOUNT.email)
  await page.getByPlaceholder('비밀번호').fill(ACCOUNT.password)
  await page.getByRole('button', { name: '로컬 계정으로 로그인' }).click()
  await expect(page).toHaveURL(/\/files/)

  // 감사 로그에 뭔가 남도록 파일 하나 업로드
  await page.locator('input[type="file"]:not([webkitdirectory])').setInputFiles({
    name: `운영_${RUN_TAG}.txt`,
    mimeType: 'text/plain',
    buffer: Buffer.from('ops'),
  })
  await expect(fileCell(page, `운영_${RUN_TAG}.txt`)).toBeVisible()

  await page.getByRole('button', { name: '관리' }).click()
  await page.getByRole('button', { name: '시스템' }).click()

  await expect(page.locator('.disk-bar')).toBeVisible()
  await expect(page.getByRole('heading', { name: '감사 로그' })).toBeVisible()
  await expect(page.getByRole('cell', { name: 'upload' }).first()).toBeVisible()
})
