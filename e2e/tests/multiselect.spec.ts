import { ADMIN, expect, loginAs, test } from './fixtures'

import { fileCell, newFolder } from './helpers'

/**
 * 트리에서 여러 개를 고르는 기능.
 *
 * **왜 다시 생겼나**: 표에 체크박스로 있던 다중선택(#60)이 트리 전용 레이아웃 개편(#96/#97)
 * 때 표와 함께 사라졌다. 사용자가 "다중 선택이 없어진 것 같은데"라고 할 때까지 아무도
 * 몰랐다 — 테스트가 표를 기준으로 쓰여 있어서, 표가 사라지자 그 테스트도 같이 지워졌기
 * 때문이다. 그래서 이번에는 **트리 기준으로** 다시 쓴다.
 *
 * 두 방향을 같이 본다.
 *   · 고른 것에 대한 동작이 제대로 되는가 (삭제·이동·내려받기)
 *   · 안 고른 것이 말려들지 않는가, 평범한 클릭이 망가지지 않았는가
 */

const buf = (s: string) => ({ name: s, mimeType: 'text/plain', buffer: Buffer.from(s) })

/** 이 테스트만의 폴더를 만들고 그 안으로 들어간다 — 다른 테스트의 파일과 섞이지 않게. */
async function inFreshFolder(page: import('@playwright/test').Page, label: string) {
  const name = `${label}_${Date.now()}`
  await newFolder(page, name)
  await fileCell(page, name).click()
  await expect(page.locator('.tree-row.active', { hasText: name })).toBeVisible()
  return name
}

/** 트리에서 이 이름을 가진 '행'(드래그·강조의 단위). .tree-row 는 자식 목록을 품지 않는다. */
const row = (page: import('@playwright/test').Page, name: string) =>
  page.locator('.tree-row').filter({ has: page.locator('.tree-name', { hasText: name }) })

test('Ctrl/Cmd+클릭으로 여러 개를 골라 한 번에 삭제한다', async ({ page }) => {
  await loginAs(page, ADMIN)
  const tag = Date.now()
  await inFreshFolder(page, '다중삭제')

  const a = `가_${tag}.txt`
  const b = `나_${tag}.txt`
  const keep = `안고른것_${tag}.txt`
  await page
    .locator('input[type="file"]:not([webkitdirectory])')
    .setInputFiles([buf(a), buf(b), buf(keep)])
  await expect(fileCell(page, keep)).toBeVisible()
  const beforeUrl = page.url()

  await fileCell(page, a).click({ modifiers: ['ControlOrMeta'] })
  await fileCell(page, b).click({ modifiers: ['ControlOrMeta'] })

  await expect(page.locator('.bulk-bar')).toContainText('2개 선택됨')
  await expect(page.locator('.tree-row.checked')).toHaveCount(2)
  // 고르기는 '여는 것'이 아니다 — Ctrl+클릭으로 파일이 열리면 주소가 그 파일로 바뀐다.
  expect(page.url()).toBe(beforeUrl)

  page.once('dialog', (d) => d.accept())
  await page.locator('.bulk-bar').getByRole('button', { name: '삭제' }).click()

  await expect(page.locator('.bulk-bar')).toHaveCount(0)
  await expect(fileCell(page, a)).toHaveCount(0)
  await expect(fileCell(page, b)).toHaveCount(0)
  await expect(fileCell(page, keep)).toBeVisible() // 안 고른 건 그대로 있다
})

test('Shift+클릭은 화면에 보이는 순서대로 범위를 고른다', async ({ page }) => {
  await loginAs(page, ADMIN)
  const tag = Date.now()
  await inFreshFolder(page, '범위선택')

  const names = [1, 2, 3, 4].map((i) => `범위${i}_${tag}.txt`)
  await page
    .locator('input[type="file"]:not([webkitdirectory])')
    .setInputFiles(names.map(buf))
  await expect(fileCell(page, names[3])).toBeVisible()

  await fileCell(page, names[0]).click({ modifiers: ['ControlOrMeta'] }) // 기준점
  await fileCell(page, names[3]).click({ modifiers: ['Shift'] }) // 여기까지

  await expect(page.locator('.bulk-bar')).toContainText('4개 선택됨')
  for (const n of names) await expect(row(page, n)).toHaveClass(/checked/)
})

test('그냥 클릭하면 그것 하나만 남고 파일이 열린다', async ({ page }) => {
  // 다중선택이 평범한 탐색을 가로채면 안 된다 — 이게 매일 쓰는 동작이다.
  //
  // 예전엔 그냥 클릭이 선택을 **비우기만** 했다(누른 것을 담지 않았다). 그래서 파일 넷을
  // 눌러도(하나는 그냥 + 셋은 Ctrl) 하단 바가 셋이라고 했다 — 처음 누른 것이 늘 빠졌다.
  // 이제 누른 것 하나가 선택으로 남는다. 바는 둘 이상일 때만 뜨므로 여기선 안 보인다.
  await loginAs(page, ADMIN)
  const tag = Date.now()
  await inFreshFolder(page, '평범한클릭')

  const a = `열릴것_${tag}.md`
  const b = `옆것_${tag}.md`
  await page.locator('input[type="file"]:not([webkitdirectory])').setInputFiles([
    { name: a, mimeType: 'text/markdown', buffer: Buffer.from('# 열린 문서\n') },
    buf(b),
  ])
  await expect(fileCell(page, a)).toBeVisible()

  await fileCell(page, a).click({ modifiers: ['ControlOrMeta'] })
  await fileCell(page, b).click({ modifiers: ['ControlOrMeta'] })
  await expect(page.locator('.bulk-bar')).toContainText('2개 선택됨')

  await fileCell(page, a).click() // 수식키 없이
  await expect(page.locator('.bulk-bar')).toHaveCount(0) // 하나뿐이라 바는 안 뜬다
  await expect(page.locator('.tree-row.checked')).toHaveCount(1) // 누른 그것만 남는다
  await expect(row(page, a)).toHaveClass(/checked/)
  await expect(page.getByRole('heading', { name: '열린 문서' })).toBeVisible()
})

test('처음 누른 파일도 개수에 들어간다', async ({ page }) => {
  // 회귀 테스트. 그냥 클릭이 선택을 비우기만 하던 시절엔 여기서 3개가 나왔다 —
  // 사용자가 "맨 처음 파일만 카운트가 안 된다"고 말한 그 증상이다.
  await loginAs(page, ADMIN)
  const tag = Date.now()
  await inFreshFolder(page, '첫클릭포함')

  const names = [1, 2, 3, 4].map((i) => `첫클릭_${i}_${tag}.txt`)
  await page
    .locator('input[type="file"]:not([webkitdirectory])')
    .setInputFiles(names.map((n) => buf(n)))
  await expect(fileCell(page, names[3])).toBeVisible()

  await fileCell(page, names[0]).click() // 그냥 클릭 — 이것도 세어져야 한다
  for (const n of names.slice(1)) await fileCell(page, n).click({ modifiers: ['ControlOrMeta'] })

  await expect(page.locator('.bulk-bar')).toContainText('4개 선택됨')
  await expect(page.locator('.tree-row.checked')).toHaveCount(4)
})

test('고른 것들을 tar.gz 하나로 내려받는다', async ({ page }) => {
  await loginAs(page, ADMIN)
  const tag = Date.now()
  await inFreshFolder(page, '묶어받기')

  const a = `받을가_${tag}.txt`
  const b = `받을나_${tag}.txt`
  await page.locator('input[type="file"]:not([webkitdirectory])').setInputFiles([buf(a), buf(b)])
  await expect(fileCell(page, b)).toBeVisible()

  await fileCell(page, a).click({ modifiers: ['ControlOrMeta'] })
  await fileCell(page, b).click({ modifiers: ['ControlOrMeta'] })

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('.bulk-bar').getByRole('button', { name: '내려받기' }).click(),
  ])
  expect(download.suggestedFilename()).toMatch(/\.tar\.gz$/)
  // 고른 개수만큼 id가 실려야 한다 — 하나만 실려도 파일 이름은 그럴듯해 보인다.
  expect(download.url()).toContain('/api/nodes/bundle?')
  expect(download.url().match(/[?&]id=/g)).toHaveLength(2)
})

test('고른 것들을 폴더로 끌면 전부 함께 옮겨진다', async ({ page }) => {
  await loginAs(page, ADMIN)
  const tag = Date.now()
  await inFreshFolder(page, '다중이동')

  const dest = `대상_${tag}`
  await newFolder(page, dest)
  await expect(fileCell(page, dest)).toBeVisible()

  const a = `옮길가_${tag}.txt`
  const b = `옮길나_${tag}.txt`
  await page.locator('input[type="file"]:not([webkitdirectory])').setInputFiles([buf(a), buf(b)])
  await expect(fileCell(page, b)).toBeVisible()

  await fileCell(page, a).click({ modifiers: ['ControlOrMeta'] })
  await fileCell(page, b).click({ modifiers: ['ControlOrMeta'] })
  await expect(page.locator('.bulk-bar')).toContainText('2개 선택됨')

  // 고른 것 중 하나를 잡아 대상 폴더로 HTML5 드래그(같은 DataTransfer로 payload가 건너간다)
  const dt = await page.evaluateHandle(() => new DataTransfer())
  await row(page, a).dispatchEvent('dragstart', { dataTransfer: dt })
  await row(page, dest).dispatchEvent('dragover', { dataTransfer: dt })
  await row(page, dest).dispatchEvent('drop', { dataTransfer: dt })

  await expect(page.locator('.bulk-bar')).toHaveCount(0) // 옮기고 나면 선택은 풀린다

  // 둘 다 대상 폴더 **안에** 들어가 있어야 한다. 트리 어딘가에 보이는 것만으로는 증명이
  // 안 된다 — 안 옮겨졌어도 원래 자리에 그대로 보이기 때문이다.
  // 대상 폴더로 들어가 펼친 뒤(접혀 있으면 자식 ul 자체가 DOM에 없다), 그 행 바로 다음의
  // ul = 그 폴더의 자식 목록만 본다. `li.tree-li` 를 'dest를 품은 것'으로 거르면
  // **조상 li 까지** 걸려서 옮겨지지 않은 항목도 안에 있는 것처럼 통과한다.
  await fileCell(page, dest).click()
  await expect(page.locator('.tree-row.active', { hasText: dest })).toBeVisible()
  const destChildren = row(page, dest).locator('xpath=following-sibling::ul[1]')
  await expect(destChildren.locator('.tree-name').filter({ hasText: a })).toBeVisible()
  await expect(destChildren.locator('.tree-name').filter({ hasText: b })).toBeVisible()
})

test('형제 파일 위에 놓아도(제자리 이동) 이름이 바뀌지 않는다', async ({ page }) => {
  // 사용자가 발견한 버그. 파일 위에 놓으면 대상은 '그 파일의 부모 폴더'라, 형제 위에
  // 놓는 건 제자리 이동이다. 빈 이름 찾기가 **자기 자신**까지 남으로 세는 바람에
  // 고른 것이 전부 '이름 (2)'가 됐다.
  await loginAs(page, ADMIN)
  const tag = Date.now()
  await inFreshFolder(page, '제자리')

  const names = [1, 2, 3].map((i) => `제자리${i}_${tag}.txt`)
  await page.locator('input[type="file"]:not([webkitdirectory])').setInputFiles(names.map(buf))
  await expect(fileCell(page, names[2])).toBeVisible()

  await fileCell(page, names[0]).click({ modifiers: ['ControlOrMeta'] })
  await fileCell(page, names[1]).click({ modifiers: ['ControlOrMeta'] })
  await expect(page.locator('.bulk-bar')).toContainText('2개 선택됨')

  // 고른 것들을 '고르지 않은 형제' 위에 놓는다 → 셋 다 같은 폴더에 있으므로 제자리다
  const dt = await page.evaluateHandle(() => new DataTransfer())
  await row(page, names[0]).dispatchEvent('dragstart', { dataTransfer: dt })
  await row(page, names[2]).dispatchEvent('dragover', { dataTransfer: dt })
  await row(page, names[2]).dispatchEvent('drop', { dataTransfer: dt })

  // 이름이 그대로여야 한다 — '(2)'가 하나라도 생기면 안 된다
  for (const n of names) await expect(fileCell(page, n)).toHaveCount(1)
  await expect(page.locator('.tree-name').filter({ hasText: ' (2)' })).toHaveCount(0)
})

test('연달아 빠르게 눌러도 클릭이 먹히지 않는다', async ({ page }) => {
  // 한 번에 세 번 — 리렌더 사이에 끼어드는 클릭. 선택을 '통째로 덮어쓰면' 마지막 하나만
  // 남는다(실제로 그랬다). 사람 손으로는 잘 안 나지만 트랙패드 연타로는 난다.
  await loginAs(page, ADMIN)
  const tag = Date.now()
  await inFreshFolder(page, '연타')

  const names = [1, 2, 3].map((i) => `연타${i}_${tag}.txt`)
  await page.locator('input[type="file"]:not([webkitdirectory])').setInputFiles(names.map(buf))
  await expect(fileCell(page, names[2])).toBeVisible()

  await page.evaluate((wanted) => {
    for (const n of wanted) {
      const el = [...document.querySelectorAll('.tree-name')].find(
        (b) => b.textContent?.trim() === n,
      )
      el?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true }))
    }
  }, names)

  await expect(page.locator('.bulk-bar')).toContainText('3개 선택됨')
  await expect(page.locator('.tree-row.checked')).toHaveCount(3)
})

test('고른 것들을 다른 공간에 놓으면 전부 복사된다 (원본은 남는다)', async ({ page }) => {
  // 드롭 매트릭스의 빈칸이었다 — 공간 드롭은 단건만, 다중선택은 폴더 드롭만 시험하고 있었다.
  await loginAs(page, ADMIN)
  const tag = Date.now()
  await inFreshFolder(page, '공간복사')

  const a = `복사가_${tag}.txt`
  const b = `복사나_${tag}.txt`
  await page.locator('input[type="file"]:not([webkitdirectory])').setInputFiles([buf(a), buf(b)])
  await expect(fileCell(page, b)).toBeVisible()

  await fileCell(page, a).click({ modifiers: ['ControlOrMeta'] })
  await fileCell(page, b).click({ modifiers: ['ControlOrMeta'] })
  await expect(page.locator('.bulk-bar')).toContainText('2개 선택됨')

  // 다른 공간 헤더에 놓는다 → 이동이 아니라 복사여야 한다
  await page.evaluate(
    ({ src, names }) => {
      const rows = [...document.querySelectorAll('.tree-row')]
      const from = rows.find((r) =>
        r.querySelector('.tree-name')?.textContent?.includes(src),
      ) as HTMLElement
      const other = [...document.querySelectorAll('.space-root')].find(
        (h) => !h.classList.contains('active'),
      ) as HTMLElement
      if (!from || !other) throw new Error(`드래그 대상을 못 찾음 (${names})`)
      const dt = new DataTransfer()
      from.dispatchEvent(new DragEvent('dragstart', { dataTransfer: dt, bubbles: true }))
      other.dispatchEvent(
        new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }),
      )
      other.dispatchEvent(
        new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }),
      )
    },
    { src: a, names: [a, b].join(', ') },
  )

  // 복사이므로 원본이 그대로 있고(이름도 그대로), 사본이 생겨 각 이름이 두 개가 된다
  await expect(fileCell(page, a)).toHaveCount(2)
  await expect(fileCell(page, b)).toHaveCount(2)
})

test('고른 것들을 휴지통에 놓으면 전부 삭제된다', async ({ page }) => {
  // 이것도 빈칸이었다 — 휴지통 드롭은 단건만 시험하고 있었다.
  await loginAs(page, ADMIN)
  const tag = Date.now()
  await inFreshFolder(page, '휴지통다중')

  const a = `버릴가_${tag}.txt`
  const b = `버릴나_${tag}.txt`
  const keep = `남길것_${tag}.txt`
  await page
    .locator('input[type="file"]:not([webkitdirectory])')
    .setInputFiles([buf(a), buf(b), buf(keep)])
  await expect(fileCell(page, keep)).toBeVisible()

  await fileCell(page, a).click({ modifiers: ['ControlOrMeta'] })
  await fileCell(page, b).click({ modifiers: ['ControlOrMeta'] })
  await expect(page.locator('.bulk-bar')).toContainText('2개 선택됨')

  const dt = await page.evaluateHandle(() => new DataTransfer())
  const trash = page.locator('.sidebar-trash')
  await row(page, a).dispatchEvent('dragstart', { dataTransfer: dt })
  await trash.dispatchEvent('dragover', { dataTransfer: dt })
  await trash.dispatchEvent('drop', { dataTransfer: dt })

  await expect(fileCell(page, a)).toHaveCount(0)
  await expect(fileCell(page, b)).toHaveCount(0)
  await expect(fileCell(page, keep)).toBeVisible() // 안 고른 건 그대로
  await expect(page.locator('.bulk-bar')).toHaveCount(0)
})

test('Esc를 누르면 선택이 풀린다', async ({ page }) => {
  await loginAs(page, ADMIN)
  const tag = Date.now()
  await inFreshFolder(page, '해제')

  const a = `해제가_${tag}.txt`
  const b = `해제나_${tag}.txt`
  await page.locator('input[type="file"]:not([webkitdirectory])').setInputFiles([buf(a), buf(b)])
  await expect(fileCell(page, b)).toBeVisible()

  await fileCell(page, a).click({ modifiers: ['ControlOrMeta'] })
  await fileCell(page, b).click({ modifiers: ['ControlOrMeta'] })
  await expect(page.locator('.bulk-bar')).toContainText('2개 선택됨')

  await page.keyboard.press('Escape')
  await expect(page.locator('.bulk-bar')).toHaveCount(0)
  await expect(fileCell(page, a)).toBeVisible() // 파일은 그대로
})
