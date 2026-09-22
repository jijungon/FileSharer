import type { Page } from '@playwright/test'

/**
 * 사이드바 파일 트리에서 이름으로 '파일/폴더 항목'을 찾는다.
 *
 * 메인 파일 목록 표를 없애고 트리 전용 탐색으로 바꾼 뒤(레이아웃 개편),
 * 항목을 열거나 존재를 확인하는 표준 수단은 트리의 `.tree-name` 버튼이다.
 * 파일이면 클릭 시 뷰어로 열리고, 폴더면 그 폴더로 들어간다.
 *
 * 업로드/폴더 생성 후 트리는 자동 갱신(treeVersion)되므로, 이름이 고유하면
 * 정확히 하나의 항목에 매칭된다(테스트마다 타임스탬프로 고유화 권장).
 */
export const fileCell = (page: Page, name: string | RegExp) =>
  page.locator('.tree-name').filter({ hasText: name })

// '새 폴더'/'새 MD' 이름 입력은 window.prompt → 인라인 모달(NameModal)로 바뀌었다.
// 네이티브 dialog 대신 모달 입력창을 채우고 '만들기'를 누른다.
async function submitNameModal(page: Page, name: string) {
  await page.locator('.name-modal .modal-input').fill(name)
  await page.locator('.name-modal').getByRole('button', { name: '만들기' }).click()
}

export async function newFolder(page: Page, name: string) {
  await page.getByRole('button', { name: /새 폴더/ }).click()
  await submitNameModal(page, name)
}

export async function newMd(page: Page, name: string) {
  await page.getByRole('button', { name: /새 MD/ }).click()
  await submitNameModal(page, name)
}
