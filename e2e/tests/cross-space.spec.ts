import { expect, test } from './fixtures'

const EMAIL = 'e2e@test.local'
const PASSWORD = 'e2e-password-123'

async function loginAdmin(page) {
  await page.goto('/login')
  await page.getByRole('button', { name: /로컬 계정으로 로그인/ }).click()
  await page.getByPlaceholder('이메일').fill(EMAIL)
  await page.getByPlaceholder('비밀번호').fill(PASSWORD)
  await page.getByRole('button', { name: '로컬 계정으로 로그인' }).click()
  await expect(page).toHaveURL(/\/files/)
}

// 브라우저의 HTML5 네이티브 드래그는 CDP 마우스로 잘 안 잡히므로,
// rowDragStart가 채운 dataTransfer를 그대로 공유해 dragstart→drop을 합성 디스패치한다.
async function dragNodeToSpaceHeader(page, fileName: string, spaceName: string) {
  await page.evaluate(
    ({ fileText, targetName }) => {
      const rows = Array.from(document.querySelectorAll('.tree-row'))
      const src = rows.find((r) =>
        r.querySelector('.tree-name')?.textContent?.includes(fileText),
      ) as HTMLElement | undefined
      const headers = Array.from(document.querySelectorAll('.space-root'))
      const tgt = headers.find((h) => h.textContent?.includes(targetName)) as
        | HTMLElement
        | undefined
      if (!src) throw new Error(`드래그 소스 행을 못 찾음: ${fileText}`)
      if (!tgt) throw new Error(`드롭 대상 공간 헤더를 못 찾음: ${targetName}`)
      const dt = new DataTransfer()
      src.dispatchEvent(new DragEvent('dragstart', { dataTransfer: dt, bubbles: true }))
      tgt.dispatchEvent(
        new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }),
      )
      tgt.dispatchEvent(
        new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }),
      )
      src.dispatchEvent(new DragEvent('dragend', { dataTransfer: dt, bubbles: true }))
    },
    { fileText: fileName, targetName: spaceName },
  )
}

// 공간 간 드롭은 '이동'이 아니라 '복사'여야 한다(원본 유지·리네임 없음).
// 두 공간 트리를 동시에 보여준 뒤로, 판단 기준을 '활성 공간'이 아니라
// '드래그한 파일의 실제 공간'으로 잡아야 팀→개인 드롭이 이동으로 오판되지 않는다.
test('공간 간 드래그는 이동이 아니라 복사다 (팀→개인, 개인 공간이 활성일 때도)', async ({
  page,
}) => {
  await loginAdmin(page)

  // 팀(=전체 공간 아날로그) 생성 + 본인 팀원 추가 + 팀 공간 루트에 파일 업로드
  const teamName = `크로스팀-${Date.now()}`
  const team = await (await page.request.post('/api/teams', { data: { name: teamName } })).json()
  const me = await (await page.request.get('/api/me')).json()
  await page.request.post(`/api/teams/${team.id}/members`, { data: { user_id: me.id } })
  const spaces = await (await page.request.get('/api/spaces')).json()
  const teamSpace = spaces.find((s: { type: string }) => s.type === 'team')
  const personalSpace =
    spaces.find((s: { type: string }) => s.type === 'personal') ??
    spaces.find((s: { id: string }) => s.id !== teamSpace.id)
  const fileName = `크로스파일-${Date.now()}.txt`
  await page.request.post(`/api/spaces/${teamSpace.id}/files`, {
    multipart: {
      file: { name: fileName, mimeType: 'text/plain', buffer: Buffer.from('cross-space') },
    },
  })

  // 두 트리가 모두 보이도록 새로고침하고 '개인 공간'을 활성으로 만든다.
  // (옛 코드: 활성=대상 → s.id===spaceId → 이동으로 오판. 새 코드: 소스=팀 → 복사)
  await page.goto('/files')
  await page.locator('.space-root', { hasText: personalSpace.name }).first().click()
  await expect(
    page.locator('.tree-row', { has: page.locator('.tree-name', { hasText: fileName }) }).first(),
  ).toBeVisible()

  await dragNodeToSpaceHeader(page, fileName, personalSpace.name)

  // 개인 공간에 '같은 이름' 복사본 1개가 생긴다(비동기 복사 → 폴링)
  await expect
    .poll(async () => {
      const kids = await (
        await page.request.get(`/api/spaces/${personalSpace.id}/children`)
      ).json()
      return kids.filter((n: { name: string }) => n.name === fileName).length
    })
    .toBe(1)

  // 팀 공간 원본은 그대로 남아 있다(이동이 아니라 복사) — 이름도 안 바뀐다.
  // 옛 버그였다면 원본이 옮겨지고 '이름 (2)'로 리네임됐을 것이다.
  const teamKids = await (await page.request.get(`/api/spaces/${teamSpace.id}/children`)).json()
  expect(teamKids.filter((n: { name: string }) => n.name === fileName).length).toBe(1)
})
