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

// 매 테스트가 자기만의 빈 폴더를 만들고 그 안으로 들어간다.
// (여러 테스트가 같은 개인공간 루트를 공유하므로 잔여물과 격리하기 위함)
async function enterFreshFolder(page, name: string) {
  page.once('dialog', (d) => d.accept(name)) // 새 폴더 이름 prompt
  await page.getByRole('button', { name: /새 폴더/ }).click()
  const row = page.getByRole('row', { name: new RegExp(name) })
  await expect(row).toBeVisible()
  await row.dblclick()
  await expect(page.getByRole('row', { name: new RegExp(name) })).toHaveCount(0) // 폴더 안(빈 상태)
}

test('체크박스로 여러 개를 선택해 한 번에 휴지통으로 보낸다', async ({ page }) => {
  await login(page)
  await enterFreshFolder(page, `삭제_${Date.now()}`)
  page.on('dialog', (d) => d.accept()) // 이후 삭제 확인창 자동 수락

  await page.locator('input[type="file"]:not([webkitdirectory])').setInputFiles([
    { name: '다중가.txt', mimeType: 'text/plain', buffer: Buffer.from('a') },
    { name: '다중나.txt', mimeType: 'text/plain', buffer: Buffer.from('b') },
  ])
  // 업로드 진행 행이 사라진 뒤(실제 파일 행으로 교체됨) 행을 다룬다
  await expect(page.locator('.upload-row')).toHaveCount(0)
  await expect(page.getByRole('row', { name: /다중가\.txt/ })).toBeVisible()
  await expect(page.getByRole('row', { name: /다중나\.txt/ })).toBeVisible()

  // 개별 체크 → 하단 바에 개수와 선택 목록이 뜬다(뷰어 자리)
  await page.getByRole('row', { name: /다중가\.txt/ }).getByRole('checkbox').check()
  const bar = page.locator('.bulk-bar')
  await expect(bar).toContainText('1개 선택됨')

  // 전체 선택 → 이 폴더의 두 개 모두 선택되고 목록에 이름이 다 뜬다
  await page.getByRole('checkbox', { name: '전체 선택' }).check()
  await expect(bar).toContainText('2개 선택됨')
  await expect(bar.locator('.bulk-bar-list')).toContainText('다중가.txt')
  await expect(bar.locator('.bulk-bar-list')).toContainText('다중나.txt')

  // 선택 삭제 → 목록에서 사라지고 휴지통에 쌓인다
  await bar.getByRole('button', { name: '선택 삭제' }).click()
  await expect(page.getByRole('cell', { name: /다중가\.txt/ })).toHaveCount(0)
  await expect(page.getByRole('cell', { name: /다중나\.txt/ })).toHaveCount(0)
  await expect(page.locator('.bulk-bar')).toHaveCount(0) // 선택 해제됨

  // 휴지통은 전역 뷰라(반복 실행 시 동명 항목이 쌓일 수 있음) 최소 1개 보이면 통과
  await page.getByRole('button', { name: '휴지통' }).click()
  await expect(page.getByRole('row', { name: /다중가\.txt/ }).first()).toBeVisible()
  await expect(page.getByRole('row', { name: /다중나\.txt/ }).first()).toBeVisible()
})

test('여러 개를 선택해 폴더로 드래그하면 모두 함께 이동한다', async ({ page }) => {
  await login(page)
  await enterFreshFolder(page, `이동_${Date.now()}`)

  // 대상 하위폴더 생성
  page.once('dialog', (d) => d.accept('대상'))
  await page.getByRole('button', { name: /새 폴더/ }).click()
  const folder = page.getByRole('row', { name: /대상/ })
  await expect(folder).toBeVisible()

  await page.locator('input[type="file"]:not([webkitdirectory])').setInputFiles([
    { name: '이동가.txt', mimeType: 'text/plain', buffer: Buffer.from('a') },
    { name: '이동나.txt', mimeType: 'text/plain', buffer: Buffer.from('b') },
  ])
  await expect(page.locator('.upload-row')).toHaveCount(0)
  await expect(page.getByRole('row', { name: /이동가\.txt/ })).toBeVisible()
  await expect(page.getByRole('row', { name: /이동나\.txt/ })).toBeVisible()

  // 두 파일만 선택
  await page.getByRole('row', { name: /이동가\.txt/ }).getByRole('checkbox').check()
  await page.getByRole('row', { name: /이동나\.txt/ }).getByRole('checkbox').check()
  await expect(page.locator('.bulk-bar')).toContainText('2개 선택됨')

  // 선택된 한 행을 잡아 대상폴더로 HTML5 드래그(공유 DataTransfer로 payload 전달)
  const dt = await page.evaluateHandle(() => new DataTransfer())
  const src = page.getByRole('row', { name: /이동가\.txt/ })
  await src.dispatchEvent('dragstart', { dataTransfer: dt })
  await folder.dispatchEvent('dragover', { dataTransfer: dt })
  await folder.dispatchEvent('drop', { dataTransfer: dt })

  // 현재 폴더에선 둘 다 사라지고
  await expect(page.getByRole('cell', { name: /이동가\.txt/ })).toHaveCount(0)
  await expect(page.getByRole('cell', { name: /이동나\.txt/ })).toHaveCount(0)
  // 대상폴더로 들어가면(사이드바 트리 = 단일 클릭으로 확실히 진입) 둘 다 있다
  await page.getByRole('complementary').getByRole('button', { name: '대상', exact: true }).click()
  await expect(page.getByRole('row', { name: /이동가\.txt/ })).toBeVisible()
  await expect(page.getByRole('row', { name: /이동나\.txt/ })).toBeVisible()
})

test('선택 해제 버튼을 누르면 다중선택이 초기화된다', async ({ page }) => {
  await login(page)
  await enterFreshFolder(page, `해제_${Date.now()}`)

  await page.locator('input[type="file"]:not([webkitdirectory])').setInputFiles([
    { name: '해제가.txt', mimeType: 'text/plain', buffer: Buffer.from('a') },
    { name: '해제나.txt', mimeType: 'text/plain', buffer: Buffer.from('b') },
  ])
  await expect(page.locator('.upload-row')).toHaveCount(0)
  await expect(page.getByRole('row', { name: /해제가\.txt/ })).toBeVisible()

  await page.getByRole('checkbox', { name: '전체 선택' }).check()
  await expect(page.locator('.bulk-bar')).toContainText('2개 선택됨')

  await page.locator('.bulk-bar').getByRole('button', { name: '선택 해제' }).click()
  await expect(page.locator('.bulk-bar')).toHaveCount(0)
  await expect(page.getByRole('row', { name: /해제가\.txt/ })).toBeVisible() // 파일은 그대로
})

test('여러 개를 선택해 다른 공간으로 드래그하면 복사된다(원본 유지)', async ({ page }) => {
  await login(page)
  const tag = Date.now()
  await enterFreshFolder(page, `복사원본_${tag}`)

  // 전역 org 공간(전체 공간)은 누적되므로 파일명을 실행마다 고유하게
  const a = `복사가_${tag}.txt`
  const b = `복사나_${tag}.txt`
  await page.locator('input[type="file"]:not([webkitdirectory])').setInputFiles([
    { name: a, mimeType: 'text/plain', buffer: Buffer.from('a') },
    { name: b, mimeType: 'text/plain', buffer: Buffer.from('b') },
  ])
  await expect(page.locator('.upload-row')).toHaveCount(0)
  await expect(page.getByRole('row', { name: new RegExp(a) })).toBeVisible()
  await expect(page.getByRole('row', { name: new RegExp(b) })).toBeVisible()

  // 두 파일 선택
  await page.getByRole('row', { name: new RegExp(a) }).getByRole('checkbox').check()
  await page.getByRole('row', { name: new RegExp(b) }).getByRole('checkbox').check()
  await expect(page.locator('.bulk-bar')).toContainText('2개 선택됨')

  // 사이드바의 다른 공간(전체 공간)으로 다중 드래그 → 복사(원본은 그대로)
  const target = page
    .getByRole('complementary')
    .getByRole('button', { name: '전체 공간', exact: true })
  const dt = await page.evaluateHandle(() => new DataTransfer())
  await page.getByRole('row', { name: new RegExp(a) }).dispatchEvent('dragstart', { dataTransfer: dt })
  await target.dispatchEvent('dragover', { dataTransfer: dt })
  await target.dispatchEvent('drop', { dataTransfer: dt })

  // 원본 공간엔 둘 다 그대로 남아 있다
  await expect(page.getByRole('row', { name: new RegExp(a) })).toBeVisible()
  await expect(page.getByRole('row', { name: new RegExp(b) })).toBeVisible()

  // 전체 공간으로 전환하면 복사본 둘 다 존재한다
  await target.click()
  await expect(page.getByRole('row', { name: new RegExp(a) })).toBeVisible()
  await expect(page.getByRole('row', { name: new RegExp(b) })).toBeVisible()
})
