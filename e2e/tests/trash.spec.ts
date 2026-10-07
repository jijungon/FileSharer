import { ACCOUNT, RUN_TAG, expect, test } from './fixtures'

/**
 * 트리에서 항목을 휴지통으로 보낸다.
 *
 * 예전엔 우클릭 메뉴(이름 변경·즐겨찾기·삭제)를 썼는데 그 메뉴를 없앴다 — 같은 일을
 * 행에서 바로 할 수 있어서다(★ 즐겨찾기 · 🗑 삭제 · 선택 후 Enter 로 이름 변경).
 * 🗑 은 `opacity: 0` 이라 눈에 잘 안 띌 뿐 **숨겨진 건 아니라서** hover 없이 눌린다.
 */
async function trashFromTree(page: import('@playwright/test').Page, item: import('@playwright/test').Locator) {
  const row = page.locator('.tree-row').filter({ has: item })
  await row.getByRole('button', { name: '휴지통으로 이동' }).click()
}


/**
 * 휴지통 행의 '완전 삭제'를 누른다.
 *
 * **hover 도 재시도도 걷어냈다.** 예전엔 그 버튼이 `visibility: hidden` 이라 행에
 * 마우스를 올려야만 존재했고, hover 와 click 사이에 목록이 다시 그려지면 hover 가
 * 풀려 버튼이 사라졌다. 그래서 hover+click 을 20초까지 두드리는 고리로 덮어뒀다.
 *
 * 지금은 `.file-table .row-action { opacity: 0 }` 이다 — **숨겨진 게 아니라 옅을
 * 뿐이고**, pointer-events 도 안 잠겨 있다(styles.css 의 그 주석 참고). Playwright 의
 * 보임 판정은 opacity 를 보지 않으므로 hover 없이 그냥 눌린다. 트리의 🗑 을 누르는
 * trashFromTree 가 이미 그렇게 하고 있었다.
 *
 * 남아 있던 고리는 **실패를 20초 동안 숨기기만** 했다 — 간헐 실패가 나면 "20초를
 * 태우고 터졌다" 는 것 말고는 아무것도 알려주지 않았다. 진짜 원인(목록 다시 그리기)은
 * 따로 고쳤다 — reload 가 늦게 온 옛 응답으로 새 목록을 덮던 것(Files.tsx).
 */
async function purge(row: import('@playwright/test').Locator) {
  await row.getByRole('button', { name: '완전 삭제' }).click()
}


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

test('트리 행의 🗑 버튼으로 파일을 휴지통으로 보낸다', async ({ page }) => {
  page.on('dialog', (d) => d.accept()) // 삭제 확인창 자동 수락
  await login(page)
  const fname = `행삭제_${Date.now()}.txt`
  await page.locator('input[type="file"]:not([webkitdirectory])').setInputFiles({
    name: fname,
    mimeType: 'text/plain',
    buffer: Buffer.from('x'),
  })
  await expect(page.locator('.upload-row')).toHaveCount(0)
  const row = page.locator('.tree-row').filter({ hasText: fname })
  await expect(row).toBeVisible()

  // 행 오른쪽 끝의 🗑(휴지통으로 이동) → confirm → 트리에서 사라지고 휴지통에 들어간다
  await row.getByRole('button', { name: '휴지통으로 이동' }).click()
  await expect(page.locator('.tree-name').filter({ hasText: fname })).toHaveCount(0)
  await page.locator('.sidebar-trash').click()
  await expect(page.getByRole('row', { name: new RegExp(fname.replace('.', '\\.')) })).toBeVisible()
})

test('휴지통 항목을 공간으로 끌어다 놓으면 원래 위치로 복원된다', async ({ page }) => {
  page.on('dialog', (d) => d.accept())
  await login(page)
  const fname = `복원드래그_${Date.now()}.txt`
  await page.locator('input[type="file"]:not([webkitdirectory])').setInputFiles({
    name: fname,
    mimeType: 'text/plain',
    buffer: Buffer.from('x'),
  })
  await expect(page.locator('.upload-row')).toHaveCount(0)

  // 휴지통으로 이동 → 트리에서 사라진다
  await page
    .locator('.tree-row')
    .filter({ hasText: fname })
    .getByRole('button', { name: '휴지통으로 이동' })
    .click()
  await expect(page.locator('.tree-name').filter({ hasText: fname })).toHaveCount(0)

  // 휴지통 열기 → 항목이 보인다
  await page.locator('.sidebar-trash').click()
  const rx = new RegExp(fname.replace('.', '\\.'))
  await expect(page.getByRole('row', { name: rx })).toBeVisible()

  // 휴지통 행을 공간 헤더(.space-root)로 끌어다 놓으면 복원 — 합성 DataTransfer dispatch
  await page.evaluate((fileText) => {
    const rows = Array.from(document.querySelectorAll('.file-table tbody tr'))
    const src = rows.find((r) =>
      r.querySelector('.node-name')?.textContent?.includes(fileText),
    ) as HTMLElement | undefined
    const tgt = document.querySelector('.space-root') as HTMLElement | null
    if (!src || !tgt) throw new Error('휴지통 행 또는 공간 헤더를 못 찾음')
    const dt = new DataTransfer()
    src.dispatchEvent(new DragEvent('dragstart', { dataTransfer: dt, bubbles: true }))
    tgt.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }))
    tgt.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }))
    src.dispatchEvent(new DragEvent('dragend', { dataTransfer: dt, bubbles: true }))
  }, fname)

  // 복원됨 → 휴지통에서 사라지고 사이드바 트리에 다시 나타난다
  await expect(page.getByRole('row', { name: rx })).toHaveCount(0)
  await expect(page.locator('.tree-name').filter({ hasText: fname })).toBeVisible()
})

test('휴지통에서 완전 삭제하면 파일이 영구히 사라진다', async ({ page }) => {
  page.on('dialog', (d) => d.accept()) // 삭제/완전삭제 확인창 자동 수락
  await login(page)

  await page.locator('input[type="file"]:not([webkitdirectory])').setInputFiles({
    name: `영구삭제_${RUN_TAG}.txt`,
    mimeType: 'text/plain',
    buffer: Buffer.from('bye'),
  })
  await expect(page.locator('.upload-row')).toHaveCount(0)
  const item = page.locator('.tree-name').filter({ hasText: `영구삭제_${RUN_TAG}.txt` })
  await expect(item).toBeVisible()

  await trashFromTree(page, item)
  await expect(page.locator('.tree-name').filter({ hasText: `영구삭제_${RUN_TAG}.txt` })).toHaveCount(0)

  // 휴지통 열기 → 항목이 보인다
  await page.locator('.sidebar-trash').click()
  const trashRow = page.getByRole('row', { name: `영구삭제_${RUN_TAG}.txt` })
  await expect(trashRow).toBeVisible()

  // 행 버튼은 **키보드로도 닿아야 한다.** 예전엔 visibility:hidden 이라 브라우저가
  // 요소를 탭 순서와 접근성 트리에서 통째로 들어냈다 — 마우스를 못 쓰면 휴지통에서
  // 복원도 완전삭제도 할 방법이 없었다. 지금은 초점을 받을 수 있고, 행에 초점이
  // 들어오면(:focus-within) 드러난다. 행이 확실히 있는 이 자리에서 같이 확인한다.
  const purgeBtn = trashRow.getByRole('button', { name: '완전 삭제' })
  await purgeBtn.focus()
  await expect(purgeBtn).toBeFocused()
  await expect(purgeBtn).toHaveCSS('opacity', '1')
  await expect(trashRow.getByRole('button', { name: '복원' })).toHaveCSS('opacity', '1')

  // 완전 삭제 → 휴지통에서도 사라진다
  await purge(trashRow)
  await expect(page.getByRole('cell', { name: `영구삭제_${RUN_TAG}.txt` })).toHaveCount(0)
})

test('파일을 열고 뷰어의 🗑 삭제를 누르면 휴지통으로 가고 뷰어가 닫힌다', async ({ page }) => {
  page.on('dialog', (d) => d.accept()) // 삭제 확인창 자동 수락
  await login(page)

  await page.locator('input[type="file"]:not([webkitdirectory])').setInputFiles({
    name: `뷰어삭제_${RUN_TAG}.txt`,
    mimeType: 'text/plain',
    buffer: Buffer.from('open then delete'),
  })
  await expect(page.locator('.upload-row')).toHaveCount(0)

  // 트리에서 파일 열기 → 에디터 뷰어가 뜬다
  await page.locator('.tree-name').filter({ hasText: `뷰어삭제_${RUN_TAG}.txt` }).click()
  await expect(page.locator('.editor-shell')).toBeVisible()

  // 뷰어 액션 바의 🗑 삭제 → confirm 수락 → 뷰어 닫힘 + 트리에서 사라짐
  await page.locator('.tab-actions').getByRole('button', { name: /삭제/ }).click()
  await expect(page.locator('.tree-name').filter({ hasText: `뷰어삭제_${RUN_TAG}.txt` })).toHaveCount(0)
  await expect(page.locator('.browser-welcome')).toBeVisible()

  // 휴지통에서 확인된다(복원 가능한 이동)
  await page.locator('.sidebar-trash').click()
  await expect(page.getByRole('row', { name: `뷰어삭제_${RUN_TAG}.txt` })).toBeVisible()
})

test('휴지통 항목에 자동 완전삭제까지 남은 시간이 표시된다', async ({ page }) => {
  page.on('dialog', (d) => d.accept())
  await login(page)

  await page.locator('input[type="file"]:not([webkitdirectory])').setInputFiles({
    name: `카운트다운_${RUN_TAG}.txt`,
    mimeType: 'text/plain',
    buffer: Buffer.from('x'),
  })
  await expect(page.locator('.upload-row')).toHaveCount(0)
  const item = page.locator('.tree-name').filter({ hasText: `카운트다운_${RUN_TAG}.txt` })
  await expect(item).toBeVisible()
  // 트리 행의 🗑 버튼으로 삭제
  await trashFromTree(page, item)
  // 삭제가 커밋되어 트리에서 빠질 때까지 기다린다 — 이 대기 없이 바로 휴지통을 열면
  // (느린 CI에서) 삭제 커밋 전에 휴지통 목록을 읽어 항목이 안 보일 수 있다.
  await expect(page.locator('.tree-name').filter({ hasText: `카운트다운_${RUN_TAG}.txt` })).toHaveCount(0)

  // 휴지통엔 전용 '삭제 예정' 열이 있고, 그 칸에 "N일 … 남음" 칩이 보인다
  await page.locator('.sidebar-trash').click()
  await expect(page.getByRole('columnheader', { name: '삭제 예정' })).toBeVisible()
  const trashRow = page.getByRole('row', { name: `카운트다운_${RUN_TAG}.txt` }).first()
  await expect(trashRow.locator('.col-remaining .trash-remaining')).toBeVisible()
  await expect(trashRow.locator('.col-remaining .trash-remaining')).toContainText('남음')
})

test('휴지통 모드에서 (휴지통에 없는) 트리 파일을 누르면 휴지통을 벗어나 뷰어가 열린다', async ({
  page,
}) => {
  await login(page)
  const fname = `트리열기_${Date.now()}.md`
  await page.locator('input[type="file"]:not([webkitdirectory])').setInputFiles({
    name: fname,
    mimeType: 'text/markdown',
    buffer: Buffer.from('# 안녕'),
  })
  await expect(page.locator('.tree-name').filter({ hasText: fname })).toBeVisible()

  // 휴지통 모드 진입 → 메인에 휴지통 목록(.file-table), 트리는 그대로 보임
  await page.locator('.sidebar-trash').click()
  await expect(page.locator('.file-table')).toBeVisible()
  await expect(page.locator('.tree-name').filter({ hasText: fname })).toBeVisible()

  // 휴지통 모드에서 트리 파일 클릭 → 휴지통을 벗어나 그 파일 뷰어(에디터)가 열린다
  await page.locator('.tree-name').filter({ hasText: fname }).click()
  await expect(page.locator('.editor-shell')).toBeVisible()
  await expect(page.locator('.sidebar-trash.active')).toHaveCount(0) // 휴지통 모드 해제
  await expect(page.locator('.file-table')).toHaveCount(0) // 휴지통 목록 사라짐
})

test('휴지통에 든 폴더의 자식 파일 딥링크는 404 (복원하면 다시 열림)', async ({ page }) => {
  // 프라이버시/정합성: 폴더를 휴지통에 넣으면 그 안의 자식 파일은 UI에서 사라지지만,
  // soft_delete가 자식엔 deleted_at을 안 찍어 자식 id를 직접 아는 딥링크로는 여전히
  // 열람/다운로드가 가능했다. 자식 딥링크(GET /api/files/{id}, /nodes/{id}/path)가
  // 404가 되는지 API 레벨로 검증한다(로그인 세션 쿠키는 page.request가 공유).
  await login(page)
  const tag = Date.now()

  const spaces = await (await page.request.get('/api/spaces')).json()
  const personal = spaces.find((s: { type: string }) => s.type === 'personal')
  const folder = await (
    await page.request.post('/api/nodes', {
      data: { space_id: personal.id, name: `딥링크폴더_${tag}` },
    })
  ).json()
  const child = await (
    await page.request.post(`/api/nodes/${folder.id}/files`, {
      multipart: {
        file: { name: `child_${tag}.txt`, mimeType: 'text/plain', buffer: Buffer.from('secret') },
      },
    })
  ).json()

  // 삭제 전: 자식 딥링크가 열린다
  expect((await page.request.get(`/api/files/${child.id}`)).status()).toBe(200)
  expect((await page.request.get(`/api/nodes/${child.id}/path`)).status()).toBe(200)

  // 부모 폴더만 휴지통으로 (자식엔 deleted_at이 안 찍힌다)
  expect((await page.request.delete(`/api/nodes/${folder.id}`)).ok()).toBeTruthy()

  // 자식 파일 딥링크는 이제 404 (열람·raw·경로 복원 모두 차단)
  expect((await page.request.get(`/api/files/${child.id}`)).status()).toBe(404)
  expect((await page.request.get(`/api/files/${child.id}/raw`)).status()).toBe(404)
  expect((await page.request.get(`/api/nodes/${child.id}/path`)).status()).toBe(404)

  // 폴더를 복원하면 자식 딥링크가 다시 열린다
  expect((await page.request.post(`/api/nodes/${folder.id}/restore`)).ok()).toBeTruthy()
  expect((await page.request.get(`/api/files/${child.id}`)).status()).toBe(200)
})

test('열어보고 별표까지 단 파일도 완전 삭제된다', async ({ page }) => {
  // 프로드에서 휴지통 자동삭제가 계속 실패하던 경로. 노드를 지우기 전에 그 노드를
  // 가리키는 행(최근 열어본 항목·별표 등)을 다 치우지 않아 FK에 걸렸다.
  // 위 테스트가 못 잡은 이유는 '올리고 바로 지운' 파일만 다뤘기 때문이다 —
  // 사람은 열어보고, 별표 달고, 그러고 나서 지운다.
  page.on('dialog', (d) => d.accept())
  await login(page)

  const name = `쓰던파일_${Date.now()}.md`
  await page.locator('input[type="file"]:not([webkitdirectory])').setInputFiles({
    name,
    mimeType: 'text/markdown',
    buffer: Buffer.from('# 쓰던 문서\n\n본문\n'),
  })
  const item = page.locator('.tree-name').filter({ hasText: name })
  await expect(item).toBeVisible()

  await item.click() // 열어본다 → node_views 행이 생긴다
  await expect(page.getByRole('heading', { name: '쓰던 문서' })).toBeVisible()

  const row = page.locator('.tree-row').filter({ has: page.locator('.tree-name', { hasText: name }) })
  await row.getByRole('button', { name: '즐겨찾기', exact: true }).click() // → favorites 행
  await expect(row.locator('.tree-fav.on')).toBeVisible()

  await trashFromTree(page, item)
  await expect(page.locator('.tree-name').filter({ hasText: name })).toHaveCount(0)

  await page.locator('.sidebar-trash').click()
  // 행은 **글자로** 집는다. getByRole('row', {name}) 은 칸을 전부 이어 붙여 이름을
  // 만드는데, 휴지통엔 '삭제 예정'(남은 시간) 칸이 있어 그 글자가 바뀌면 통째로 어긋난다.
  const trashRow = page.locator('.file-table tbody tr').filter({ hasText: name })
  await expect(trashRow).toBeVisible()

  await purge(trashRow)
  // 실패하면 행이 그대로 남는다(guard가 에러를 띄우고 목록을 다시 읽으므로)
  await expect(page.locator('.file-table tbody tr').filter({ hasText: name })).toHaveCount(0)
})

/** 늦게 온 옛 목록이 **휴지통 목록을 덮지 않는다.**
 *
 * 파일을 지우면 guard 가 reload 를 한 번 돌리고(일반 목록), 바로 휴지통을 누르면
 * 또 돈다(휴지통 목록). 둘 중 **먼저 보낸 쪽이 늦게 도착하면** 휴지통 화면에 일반
 * 목록이 들어앉아, 방금 지운 파일이 휴지통에 없는 것처럼 보였다.
 *
 * 실제로 이것 때문에 위 테스트가 간헐 실패했다. 그런데 간헐 실패는 **고쳤다는 증거가
 * 되지 못한다** — 초록이어도 그날 운이 좋았을 수 있다. 그래서 여기서는 일반 목록
 * 응답을 일부러 늦춰 **경쟁을 확실히 만들어 놓고** 본다.
 */
test('지우고 바로 휴지통을 눌러도, 늦게 온 옛 목록이 덮어쓰지 않는다', async ({ page }) => {
  page.on('dialog', (d) => d.accept())
  await login(page)

  const name = `경쟁_${Date.now()}.txt`
  await page.locator('input[type="file"]:not([webkitdirectory])').setInputFiles({
    name,
    mimeType: 'text/plain',
    buffer: Buffer.from('x'),
  })
  const item = page.locator('.tree-name').filter({ hasText: name })
  await expect(item).toBeVisible()

  // **일반 목록만** 늦춘다. 휴지통 목록은 그대로라 반드시 뒤집힌다.
  await page.route('**/api/spaces/*/children', async (route) => {
    await new Promise((r) => setTimeout(r, 1500))
    await route.continue()
  })
  const slowList = page.waitForResponse((r) => r.url().includes('/children'))

  await trashFromTree(page, item)
  await page.locator('.sidebar-trash').click()

  const trashRow = page.locator('.file-table tbody tr').filter({ hasText: name })
  await expect(trashRow).toBeVisible()

  // **늦은 응답이 도착한 뒤에 본다.** toBeVisible 은 지금 보이면 바로 통과하지,
  // 나중에 사라지는지는 보지 않는다 — 처음엔 그렇게 짰다가, 고장난 코드에서도
  // 테스트가 통과하는 걸 보고 알았다.
  await slowList
  await expect(trashRow, '늦게 온 일반 목록이 휴지통 목록을 덮었다').toBeVisible()
  await expect(page.locator('.sidebar-trash')).toHaveClass(/active/)
})
