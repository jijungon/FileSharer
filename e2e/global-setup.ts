import { request } from '@playwright/test'

/**
 * 실행 시작에 **한 번만** 전체를 비운다.
 *
 * 테스트마다 도는 리셋은 이제 '내 계정 범위'로만 좁혀져 있다(병렬을 위해서다 —
 * tests/fixtures.ts 참고). 그래서 아무도 안 치우는 곳이 생긴다: **전체 공간(org)** 과
 * 팀 공간이다. 거기 남은 찌꺼기가 다음 실행의 트리에 그대로 나타나 로케이터를
 * 모호하게 만든다(실제로 `name: '휴지통'` 이 행마다 붙은 🗑 까지 잡았다).
 *
 * 한 번만 도므로 워커끼리 부딪히지 않는다.
 */
export default async function globalSetup() {
  const baseURL = process.env.BASE_URL ?? 'http://localhost:8484'
  const api = await request.newContext({ baseURL })
  try {
    const res = await api.post('/api/test/reset') // email 없음 = 전부
    if (res.ok()) {
      const body = await res.json()
      console.log(`[globalSetup] 전체 초기화: 노드 ${body.nodes_deleted}개, 블롭 ${body.blobs_deleted}개`)
    }
  } catch {
    // 리셋 라우트가 없는 환경(ENABLE_TEST_RESET 미설정)이면 조용히 넘어간다
  } finally {
    await api.dispose()
  }
}
