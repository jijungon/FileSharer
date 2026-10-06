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

async function upload(page, name: string) {
  await page.locator('input[type="file"]:not([webkitdirectory])').setInputFiles({
    name,
    mimeType: 'text/markdown',
    buffer: Buffer.from(`# ${name}\n`),
  })
  await expect(page.locator('.tree-name').filter({ hasText: name })).toBeVisible()
}


/** 네이티브 드래그는 CDP 마우스로 잘 안 잡힌다 — dataTransfer 를 공유해 합성한다. */
async function dragInto(page, fileName: string, folderName: string) {
  await page.evaluate(
    ({ fileText, folderText }) => {
      const rows = Array.from(document.querySelectorAll('.tree-row'))
      const find = (t: string) =>
        rows.find((r) => r.querySelector('.tree-name')?.textContent?.includes(t)) as
          | HTMLElement
          | undefined
      const src = find(fileText)
      const tgt = find(folderText)
      if (!src || !tgt) throw new Error(`드래그 대상을 못 찾음: ${fileText} → ${folderText}`)
      const dt = new DataTransfer()
      src.dispatchEvent(new DragEvent('dragstart', { dataTransfer: dt, bubbles: true }))
      tgt.dispatchEvent(
        new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }),
      )
      tgt.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }))
      src.dispatchEvent(new DragEvent('dragend', { dataTransfer: dt, bubbles: true }))
    },
    { fileText: fileName, folderText: folderName },
  )
}

/** **자기 폴더 안에서만 논다.** 트리는 모든 테스트가 올린 파일을 함께 보여주므로,
 *  `.first()` 같은 걸로 집으면 남이 만든 폴더가 걸린다(실제로 걸렸다 — 폴더는 Space 로
 *  담기지 않으니 '선택이 안 된다'는 엉뚱한 실패가 났다). 내 폴더를 만들고 그 안에
 *  내 파일만 넣으면, 줄 순서도 내가 정한 대로다. */
async function makeFolderWith(page, folder: string, files: string[]) {
  await page.getByRole('button', { name: '새 폴더' }).click()
  await page.getByRole('textbox').last().fill(folder)
  await page.getByRole('button', { name: '만들기' }).click()
  await expect(page.locator('.tree-name').filter({ hasText: folder })).toBeVisible()
  for (const f of files) {
    await upload(page, f)
    await dragInto(page, f, folder)
    await expect(page.locator('.tree-name').filter({ hasText: f })).toHaveCount(0)
  }
}

/** 폴더를 펼치고 그 안 첫 줄에 커서를 둔다. */
async function enterFolder(page, folder: string) {
  const head = page.locator('.tree-name').filter({ hasText: folder })
  await head.focus()
  const item = page
    .locator('.tree-row')
    .filter({ has: page.locator('.tree-name', { hasText: folder }) })
  if ((await item.getAttribute('aria-expanded')) !== 'true') {
    await page.keyboard.press('ArrowRight')
  }
  await expect(item).toHaveAttribute('aria-expanded', 'true')
  await page.keyboard.press('ArrowRight') // 안 첫 줄로
  return item
}

/** 지금 포커스가 올라간 행의 이름. **키보드 커서는 진짜 포커스**라 이렇게 읽을 수 있다. */
function focusedName(page) {
  return page.evaluate(() => document.activeElement?.textContent ?? '')
}

test('키보드: 화살표로 줄을 옮겨 다닌다', async ({ page }) => {
  await login(page)
  const tag = Date.now()
  const folder = `이동_${tag}`
  await makeFolderWith(page, folder, [`1_${tag}.md`, `2_${tag}.md`])
  await enterFolder(page, folder)

  const first = await focusedName(page)
  await page.keyboard.press('ArrowDown')
  const second = await focusedName(page)
  expect(second).not.toBe(first)

  await page.keyboard.press('ArrowUp')
  expect(await focusedName(page)).toBe(first)
})

test('키보드: Space 로 집고, Shift+화살표로 지나온 줄을 담는다', async ({ page }) => {
  await login(page)
  const tag = Date.now()
  const folder = `선택_${tag}`
  await makeFolderWith(page, folder, [`1_${tag}.md`, `2_${tag}.md`, `3_${tag}.md`])
  await enterFolder(page, folder)

  await page.keyboard.press('Space')
  await expect(page.locator('.tree-row.checked')).toHaveCount(1)

  await page.keyboard.press('Shift+ArrowDown')
  await page.keyboard.press('Shift+ArrowDown')
  await expect(page.locator('.tree-row.checked')).toHaveCount(3)
  await expect(page.getByRole('status', { name: '선택 항목' })).toContainText('3개 선택됨')
})

test('키보드: 폴더는 →로 펼치고 ←로 접는다, ←는 부모로도 올라간다', async ({ page }) => {
  await login(page)
  const tag = Date.now()
  const folder = `상자_${tag}`
  const inside = `안쪽_${tag}.md`
  await makeFolderWith(page, folder, [inside])

  const item = await enterFolder(page, folder)
  expect(await focusedName(page)).toContain(inside)

  // ← 는 부모로 올라온다 — 깊이 들어갔을 때 빠져나오는 길
  await page.keyboard.press('ArrowLeft')
  expect(await focusedName(page)).toContain(folder)

  // 펼친 폴더에서 ← 는 접는다
  await page.keyboard.press('ArrowLeft')
  await expect(item).toHaveAttribute('aria-expanded', 'false')
})

/** Enter 는 **이름 바꾸기**다(Finder 방식, 원래 그랬다). 화살표를 붙이면서 바꾸지 않았다. */
test('키보드: Enter 는 여전히 이름 바꾸기, 여는 건 ⌘↓', async ({ page }) => {
  await login(page)
  const name = `문서_${Date.now()}.md`
  await upload(page, name)

  const row = page.locator('.tree-name').filter({ hasText: name })
  await row.focus()
  await page.keyboard.press('Enter')
  await expect(page.locator('.tree-rename-input')).toBeVisible() // 제자리 입력창
  await page.keyboard.press('Escape')

  await row.focus()
  await page.keyboard.press('ControlOrMeta+ArrowDown')
  await expect(page.locator('.cm-content')).toBeVisible() // 에디터가 열렸다
})

/** 로빙 탭인덱스 — 트리에서 Tab 으로 닿는 행은 **하나**여야 한다.
 *  이게 깨지면 파일이 200개일 때 Tab 을 200번 눌러야 트리를 빠져나간다. */
test('키보드: Tab 으로 닿는 트리 행은 하나뿐이다', async ({ page }) => {
  await login(page)
  const tag = Date.now()
  for (const n of ['가', '나', '다']) await upload(page, `${n}_${tag}.md`)

  const reachable = await page.locator('.tree-name[tabindex="0"]').count()
  expect(reachable, 'tabIndex=0 인 트리 행은 공간마다 하나여야 한다').toBeLessThanOrEqual(
    await page.locator('[role="tree"]').count(),
  )
  expect(reachable).toBeGreaterThan(0)
})
