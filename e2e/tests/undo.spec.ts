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

async function upload(page, name: string, body = '# 본문\n') {
  await page.locator('input[type="file"]:not([webkitdirectory])').setInputFiles({
    name,
    mimeType: 'text/markdown',
    buffer: Buffer.from(body),
  })
  await expect(page.locator('.tree-name').filter({ hasText: name })).toBeVisible()
}

/** 네이티브 드래그는 CDP 마우스로 잘 안 잡힌다 — dataTransfer 를 공유해 합성한다.
 *  (cross-space.spec.ts 와 같은 수법. 거기선 공간 헤더가 대상이고 여기선 폴더 행이다.) */
async function dragRowOntoRow(page, fileName: string, folderName: string) {
  await page.evaluate(
    ({ fileText, folderText }) => {
      const rows = Array.from(document.querySelectorAll('.tree-row'))
      const find = (t: string) =>
        rows.find((r) => r.querySelector('.tree-name')?.textContent?.includes(t)) as
          | HTMLElement
          | undefined
      const src = find(fileText)
      const tgt = find(folderText)
      if (!src) throw new Error(`드래그 소스를 못 찾음: ${fileText}`)
      if (!tgt) throw new Error(`드롭 대상 폴더를 못 찾음: ${folderText}`)
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

/** 되돌리기 — 드래그 실수가 실제로 **제자리로** 돌아오나.
 *
 * 이게 없을 땐 엉뚱한 폴더에 떨어뜨리면 어디서 왔는지 아무도 기억하지 않았다. 하나씩
 * 더듬어 되돌리는 수밖에 없었다. 그래서 '배너가 뜬다' 로는 모자라고, **파일이 원래 자리에
 * 다시 있는지**까지 봐야 한다.
 */
test('되돌리기: 엉뚱한 폴더에 떨어뜨린 파일이 제자리로 돌아온다', async ({ page }) => {
  page.on('dialog', (d) => d.accept())
  await login(page)

  const folder = `보관함_${Date.now()}`
  const file = `보고서_${Date.now()}.md`

  await page.getByRole('button', { name: '새 폴더' }).click()
  await page.getByRole('textbox').last().fill(folder)
  await page.getByRole('button', { name: '만들기' }).click()
  await expect(page.locator('.tree-name').filter({ hasText: folder })).toBeVisible()

  await upload(page, file)
  await dragRowOntoRow(page, file, folder)

  // 옮겨졌다 — 이 자리에서 사라진다
  await expect(page.locator('.tree-name').filter({ hasText: file })).toHaveCount(0)

  // 띠가 **무슨 일이 있었는지** 말한다. 조사까지 맞아야 한다('…를 … 으로/로').
  const bar = page.getByRole('status', { name: '되돌리기' })
  await expect(bar).toContainText(file)
  await expect(bar).toContainText(folder)
  await expect(bar).toContainText('옮겼습니다')

  await bar.getByRole('button', { name: '되돌리기', exact: true }).click()

  // **핵심**: 원래 자리에 다시 있다. 띠가 사라지는 것만 봐서는 아무것도 증명 못 한다.
  await expect(page.locator('.tree-name').filter({ hasText: file })).toBeVisible()
  await expect(bar).toHaveCount(0)
})

test('되돌리기: 휴지통으로 보낸 파일이 ⌘Z 로 돌아온다', async ({ page }) => {
  page.on('dialog', (d) => d.accept())
  await login(page)

  const file = `지울것_${Date.now()}.md`
  await upload(page, file)

  const row = page
    .locator('.tree-row')
    .filter({ has: page.locator('.tree-name', { hasText: file }) })
  await row.getByRole('button', { name: '휴지통으로 이동' }).click()
  await expect(page.locator('.tree-name').filter({ hasText: file })).toHaveCount(0)

  const bar = page.getByRole('status', { name: '되돌리기' })
  await expect(bar).toContainText('휴지통으로 보냈습니다')

  // 키로도 된다 — 손이 마우스로 가지 않아도 되는 게 되돌리기의 값어치다
  await page.keyboard.press('ControlOrMeta+z')
  await expect(page.locator('.tree-name').filter({ hasText: file })).toBeVisible()
})

/** 에디터 안에서는 ⌘Z 가 **글자** 되돌리기여야 한다. 파일이 움직이면 안 된다. */
test('되돌리기: 에디터 안에서 ⌘Z 는 가로채지 않는다', async ({ page }) => {
  page.on('dialog', (d) => d.accept())
  await login(page)

  const file = `편집중_${Date.now()}.md`
  await upload(page, file)

  const row = page
    .locator('.tree-row')
    .filter({ has: page.locator('.tree-name', { hasText: file }) })
  await row.getByRole('button', { name: '휴지통으로 이동' }).click()
  await expect(page.getByRole('status', { name: '되돌리기' })).toBeVisible()

  // 다른 파일을 열어 에디터에 커서를 둔다
  const other = `문서_${Date.now()}.md`
  await upload(page, other)
  await page.locator('.tree-name').filter({ hasText: other }).click()
  await page.locator('.cm-content').click()
  await page.keyboard.type('한 글자')
  await page.keyboard.press('ControlOrMeta+z')

  // 지운 파일은 **여전히 휴지통에 있어야** 한다 — 에디터의 ⌘Z 가 파일을 되살리면 안 된다
  await expect(page.locator('.tree-name').filter({ hasText: file })).toHaveCount(0)
})
