import type { Page } from '@playwright/test'

/**
 * 업로드 진행 행(.upload-row)을 제외한 '실제 파일 행'의 이름 셀을 찾는다.
 *
 * 업로드 직후 짧은 순간, 인라인 진행 행과 실제 파일 행이 같은 파일 이름을
 * 동시에 렌더링할 수 있다. 그때 `getByRole('cell', { name })`은 두 셀에
 * 매칭되어(strict mode 위반) 실패하거나, 진행 행 셀을 눌러 파일이 열리지
 * 않는 플레이크가 났다. 실제 행(tr:not(.upload-row))으로 스코프를 좁히면
 * 타이밍과 무관하게 항상 실제 파일 행만 가리킨다.
 */
export const fileCell = (page: Page, name: string | RegExp) =>
  page.locator('tr:not(.upload-row)').getByRole('cell', { name })
