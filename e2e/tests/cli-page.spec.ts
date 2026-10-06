import { ACCOUNT, expect, test } from './fixtures'

const EMAIL = ACCOUNT.email
const PASSWORD = ACCOUNT.password

async function login(page) {
  await page.goto('/login')
  await page.getByRole('button', { name: /로컬 계정으로 로그인/ }).click()
  await page.getByPlaceholder('이메일').fill(EMAIL)
  await page.getByPlaceholder('비밀번호').fill(PASSWORD)
  await page.getByRole('button', { name: '로컬 계정으로 로그인' }).click()
  await expect(page).toHaveURL(/\/files/)
}

test('CLI 안내 페이지: 설치·로그인·명령이 그대로 복사할 수 있게 있다', async ({ page }) => {
  await login(page)
  await page.goto('/cli')

  // 설치 한 줄에 **이 서버 주소**가 들어 있어야 한다 — 받는 쪽이 주소를 외울 일이 없게
  const install = page.locator('.cli-cmd code').first()
  await expect(install).toContainText('/cli/install.sh')
  await expect(install).toContainText(new URL(page.url()).origin)

  for (const cmd of ['filesharer login', 'filesharer ls', 'filesharer put', 'filesharer get']) {
    await expect(page.locator('.cli-cmd code', { hasText: cmd }).first()).toBeVisible()
  }
})

test('CLI 안내 페이지: 로그인된 기기가 보이고 회수할 수 있다', async ({ page }) => {
  await login(page)
  // 기기 하나를 만들어 둔다 — 디바이스 플로우를 거치지 않고 토큰만 바로 발급
  const made = await page.request.post('/api/tokens', {
    data: { label: 'ci-runner', expires_in_days: 7 },
  })
  expect(made.status()).toBe(201)

  await page.goto('/cli')
  const row = page.locator('.cli-table tbody tr', { hasText: 'ci-runner' })
  await expect(row).toBeVisible()
  // 안 쓰이는 자격이 정리 대상이라 '마지막 사용'을 보여준다
  await expect(row).toContainText('쓰인 적 없음')

  page.once('dialog', (d) => d.accept())
  await row.getByRole('button', { name: '회수' }).click()
  await expect(page.locator('.cli-table tbody tr', { hasText: 'ci-runner' })).toHaveCount(0)
})

test('CLI 안내 페이지: 로그인 안 했으면 로그인 뒤 여기로 돌아온다', async ({ browser }) => {
  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  await page.goto('/cli')
  await expect(page).toHaveURL(/\/login\?next=%2Fcli|\/login\?next=\/cli/)

  await page.getByRole('button', { name: /로컬 계정으로 로그인/ }).click()
  await page.getByPlaceholder('이메일').fill(EMAIL)
  await page.getByPlaceholder('비밀번호').fill(PASSWORD)
  await page.getByRole('button', { name: '로컬 계정으로 로그인' }).click()

  await expect(page).toHaveURL(/\/cli$/)
  await expect(page.getByRole('heading', { name: /CLI/ })).toBeVisible()
  await ctx.close()
})

test('서버가 내주는 CLI: 받으면 바로 돌아가는 파이썬 파일이다', async ({ request }) => {
  const install = await request.get('/cli/install.sh')
  expect(install.status()).toBe(200)
  expect((await install.text()).startsWith('#!/bin/sh')).toBeTruthy()

  const cli = await request.get('/cli/filesharer')
  expect(cli.status()).toBe(200)
  const src = await cli.text()
  expect(src.startsWith('#!/usr/bin/env python3')).toBeTruthy()
  // 자리표시자가 남아 있으면 받는 쪽이 서버를 못 찾는다
  expect(src).not.toContain('DEFAULT_SERVER = "__FILESHARER_SERVER__"')
})

test('서버 전송 팝오버에서 CLI 안내로 가는 길이 있다', async ({ page }) => {
  await login(page)
  await page.getByRole('button', { name: '서버', exact: true }).click()
  const link = page.locator('.share-popover').getByRole('link', { name: 'CLI 쓰기' })
  await expect(link).toBeVisible()
  await expect(link).toHaveAttribute('href', '/cli')
})
