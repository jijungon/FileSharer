import { expect, test } from './fixtures'

const EMAIL = 'e2e@test.local'
const PASSWORD = 'e2e-password-123'

async function loginAsAdmin(page) {
  await page.goto('/login')
  await page.getByRole('button', { name: /로컬 계정으로 로그인/ }).click()
  await page.getByPlaceholder('이메일').fill(EMAIL)
  await page.getByPlaceholder('비밀번호').fill(PASSWORD)
  await page.getByRole('button', { name: '로컬 계정으로 로그인' }).click()
  await expect(page).toHaveURL(/\/files/)
}

test('업로드 중 파일 목록에 진행 행이 뜨고, 완료되면 실제 파일로 바뀐다', async ({ page }) => {
  await loginAsAdmin(page)

  // 업로드 요청을 잠시 지연 → XHR pending 동안 인라인 진행 행이 보여야 한다
  await page.route('**/api/spaces/*/files', async (route) => {
    await new Promise((r) => setTimeout(r, 1500))
    await route.continue()
  })

  await page.locator('input[type="file"]:not([webkitdirectory])').setInputFiles({
    name: '진행.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('x'.repeat(2000)),
  })

  const uploadRow = page.locator('.upload-row')
  await expect(uploadRow).toContainText('진행.txt')
  await expect(uploadRow.locator('.upload-inline-bar')).toBeVisible()

  // 완료되면 진행 행이 사라지고 실제 파일이 트리에 나타난다
  await expect(page.locator('.upload-row')).toHaveCount(0, { timeout: 6000 })
  await expect(page.locator('.tree-name').filter({ hasText: /진행\.txt/ })).toBeVisible()
})

test('여러 파일 업로드 시 툴바에 전체 개수가 표시되고, 각 파일이 진행 행으로 뜬다', async ({ page }) => {
  await loginAsAdmin(page)

  await page.route('**/api/spaces/*/files', async (route) => {
    await new Promise((r) => setTimeout(r, 1500))
    await route.continue()
  })

  await page.locator('input[type="file"]:not([webkitdirectory])').setInputFiles([
    { name: '다중1.txt', mimeType: 'text/plain', buffer: Buffer.from('a'.repeat(1000)) },
    { name: '다중2.txt', mimeType: 'text/plain', buffer: Buffer.from('b'.repeat(1000)) },
    { name: '다중3.txt', mimeType: 'text/plain', buffer: Buffer.from('c'.repeat(1000)) },
  ])

  // 툴바 개수(…/3) + 세 개의 인라인 진행 행
  await expect(page.locator('.upload-count')).toContainText('/3')
  await expect(page.locator('.upload-row')).toHaveCount(3)

  // 모두 끝나면 진행 행이 사라지고 실제 파일이 트리에 나타난다
  await expect(page.locator('.upload-row')).toHaveCount(0, { timeout: 6000 })
  await expect(page.locator('.tree-name').filter({ hasText: /다중2\.txt/ })).toBeVisible()
})

test('일부 업로드가 실패하면 그 행만 실패로 표시되고 나머지는 완료된다', async ({ page }) => {
  await loginAsAdmin(page)

  // multipart 본문의 파일명으로 대상 구분: '실패.txt' 요청만 500, 나머지는 통과
  await page.route('**/api/spaces/*/files', async (route) => {
    const body = route.request().postData() ?? ''
    if (body.includes('실패.txt')) {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ detail: '서버 오류' }),
      })
    } else {
      // 성공 파일을 잠시 지연 → 배치가 바로 끝나 진행 행이 사라지기 전에 실패 행을 검증
      await new Promise((r) => setTimeout(r, 2000))
      await route.continue()
    }
  })

  await page.locator('input[type="file"]:not([webkitdirectory])').setInputFiles([
    { name: '성공A.txt', mimeType: 'text/plain', buffer: Buffer.from('a') },
    { name: '실패.txt', mimeType: 'text/plain', buffer: Buffer.from('b') },
  ])

  // 실패 행은 error 상태 + '실패' 표기, 툴바 개수에 실패 1
  const errorRow = page.locator('.upload-row.error')
  await expect(errorRow).toContainText('실패.txt')
  await expect(errorRow.locator('.upload-inline-pct')).toContainText('실패')
  await expect(page.locator('.upload-count')).toContainText('실패 1')

  // 실패해도 성공한 파일은 트리에 나타난다
  await expect(page.locator('.tree-name').filter({ hasText: /성공A\.txt/ })).toBeVisible()
})

test('로컬 파일을 트리의 폴더에 끌어다 놓으면 그 폴더 안으로 업로드된다', async ({ page }) => {
  await loginAsAdmin(page)
  const spaces = await page.request.get('/api/spaces').then((r) => r.json())
  const pid = spaces.find((s: { type: string }) => s.type === 'personal').id
  const name = `드롭대상-${Date.now()}`
  const folder = await page.request
    .post('/api/nodes', { data: { space_id: pid, name } })
    .then((r) => r.json())

  // 개인 공간을 활성화(트리에 방금 만든 폴더가 보이도록 새로 로드)
  await page.reload()
  await page.locator('button.space-root').filter({ hasText: '내 공간' }).click()
  const row = page.locator('.tree-row').filter({ hasText: name })
  await expect(row).toBeVisible()

  // 로컬 파일 하나를 DataTransfer로 만들어 폴더 행에 dragover→drop
  const dt = await page.evaluateHandle(() => {
    const d = new DataTransfer()
    d.items.add(new File(['dropped-body'], 'dropped.txt', { type: 'text/plain' }))
    return d
  })
  await row.dispatchEvent('dragover', { dataTransfer: dt })
  await row.dispatchEvent('drop', { dataTransfer: dt })

  // 그 폴더 '안'에 dropped.txt 가 생겨야 한다(업로드는 비동기 → poll)
  await expect
    .poll(
      () =>
        page.request
          .get(`/api/nodes/${folder.id}/children`)
          .then((r) => r.json())
          .then((kids: { name: string }[]) => kids.map((n) => n.name)),
      { timeout: 6000 },
    )
    .toContain('dropped.txt')
})

test('로컬 파일을 트리의 "파일" 위에 놓으면 그 파일이 든 폴더로 업로드된다', async ({ page }) => {
  await loginAsAdmin(page)
  const spaces = await page.request.get('/api/spaces').then((r) => r.json())
  const pid = spaces.find((s: { type: string }) => s.type === 'personal').id
  const fname = `부모폴더-${Date.now()}`
  const folder = await page.request
    .post('/api/nodes', { data: { space_id: pid, name: fname } })
    .then((r) => r.json())
  // 그 폴더 '안'에 기준이 될 파일 하나를 만든다 — 이 '파일 행' 위에 드롭할 것이다
  await page.request.post(`/api/nodes/${folder.id}/files`, {
    multipart: {
      file: { name: 'anchor.txt', mimeType: 'text/plain', buffer: Buffer.from('anchor') },
    },
  })

  // 개인 공간 활성화 + 폴더를 펼쳐 그 안의 anchor.txt 행이 보이게
  await page.reload()
  await page.locator('button.space-root').filter({ hasText: '내 공간' }).click()
  await page.locator('.tree-name').filter({ hasText: fname }).click()
  const fileRow = page.locator('.tree-row').filter({ hasText: 'anchor.txt' })
  await expect(fileRow).toBeVisible()

  // 로컬 파일을 '폴더'가 아닌 '파일 행'에 dragover→drop → 그 파일의 부모 폴더로 올라가야 한다
  const dt = await page.evaluateHandle(() => {
    const d = new DataTransfer()
    d.items.add(new File(['dropped-onto-file'], 'onto-file.txt', { type: 'text/plain' }))
    return d
  })
  await fileRow.dispatchEvent('dragover', { dataTransfer: dt })
  await fileRow.dispatchEvent('drop', { dataTransfer: dt })

  // 부모 폴더 children 에 새 파일이 anchor.txt 와 나란히 생겨야 한다
  await expect
    .poll(
      () =>
        page.request
          .get(`/api/nodes/${folder.id}/children`)
          .then((r) => r.json())
          .then((kids: { name: string }[]) => kids.map((n) => n.name)),
      { timeout: 6000 },
    )
    .toContain('onto-file.txt')
})
