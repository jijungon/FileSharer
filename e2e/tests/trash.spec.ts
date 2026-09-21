import { expect, test } from '@playwright/test'

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

test('휴지통에서 완전 삭제하면 파일이 영구히 사라진다', async ({ page }) => {
  page.on('dialog', (d) => d.accept()) // 삭제/완전삭제 확인창 자동 수락
  await login(page)

  await page.locator('input[type="file"]:not([webkitdirectory])').setInputFiles({
    name: '영구삭제.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('bye'),
  })
  await expect(page.locator('.upload-row')).toHaveCount(0)
  const item = page.locator('.tree-name').filter({ hasText: /영구삭제\.txt/ })
  await expect(item).toBeVisible()

  // 트리 우클릭 → 🗑 삭제 → 휴지통으로 (confirm 자동 수락)
  await item.click({ button: 'right' })
  await page.getByRole('menuitem', { name: /삭제/ }).click()
  await expect(page.locator('.tree-name').filter({ hasText: /영구삭제\.txt/ })).toHaveCount(0)

  // 휴지통 열기 → 항목이 보인다
  await page.getByRole('button', { name: '휴지통' }).click()
  const trashRow = page.getByRole('row', { name: /영구삭제\.txt/ })
  await expect(trashRow).toBeVisible()

  // 완전 삭제 → 휴지통에서도 사라진다
  await trashRow.hover()
  await trashRow.getByRole('button', { name: '완전 삭제' }).click()
  await expect(page.getByRole('cell', { name: /영구삭제\.txt/ })).toHaveCount(0)
})

test('휴지통 항목에 자동 완전삭제까지 남은 시간이 표시된다', async ({ page }) => {
  page.on('dialog', (d) => d.accept())
  await login(page)

  await page.locator('input[type="file"]:not([webkitdirectory])').setInputFiles({
    name: '카운트다운.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('x'),
  })
  await expect(page.locator('.upload-row')).toHaveCount(0)
  const item = page.locator('.tree-name').filter({ hasText: /카운트다운\.txt/ })
  await expect(item).toBeVisible()
  // 트리 우클릭 → 🗑 삭제
  await item.click({ button: 'right' })
  await page.getByRole('menuitem', { name: /삭제/ }).click()
  // 삭제가 커밋되어 트리에서 빠질 때까지 기다린다 — 이 대기 없이 바로 휴지통을 열면
  // (느린 CI에서) 삭제 커밋 전에 휴지통 목록을 읽어 항목이 안 보일 수 있다.
  await expect(page.locator('.tree-name').filter({ hasText: /카운트다운\.txt/ })).toHaveCount(0)

  // 휴지통엔 전용 '삭제 예정' 열이 있고, 그 칸에 "N일 … 남음" 칩이 보인다
  await page.getByRole('button', { name: '휴지통' }).click()
  await expect(page.getByRole('columnheader', { name: '삭제 예정' })).toBeVisible()
  const trashRow = page.getByRole('row', { name: /카운트다운\.txt/ }).first()
  await expect(trashRow.locator('.col-remaining .trash-remaining')).toBeVisible()
  await expect(trashRow.locator('.col-remaining .trash-remaining')).toContainText('남음')
})
