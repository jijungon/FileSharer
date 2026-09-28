import { describe, expect, it } from 'vitest'
import { redact, scrub } from './sentry'

// 공유 페이지 주소가 /s/<토큰> 이고, 그 토큰이 곧 파일 접근 권한이다.
// 에러 리포트(제3자 서버에 남는다)에 그대로 들어가면 리포트를 본 사람이 파일을 받을 수 있다.
// 일부러 '명백히 가짜'로 만든다 — 진짜처럼 생긴 토큰은 비밀 스캐너가 잡고(CI가 실제로 잡았다),
// 무엇보다 진짜와 구분이 안 된다. 길이·형식만 맞으면 검증에는 충분하다.
const SHARE = 'sharetoken'.repeat(5)
const TOKEN = `fsk_${'a'.repeat(8)}.${'b'.repeat(16)}`

describe('redact', () => {
  it('공유 링크 토큰을 지운다', () => {
    const out = redact(`https://file.rgrg.im/s/${SHARE}/download`)
    expect(out).not.toContain(SHARE)
    expect(out).toContain('/s/<share-token>/download')
  })

  it('API 토큰을 지운다', () => {
    expect(redact(`Bearer ${TOKEN}`)).not.toContain(TOKEN)
  })

  it('토큰이 아닌 짧은 /s/ 경로는 그대로 둔다', () => {
    // 다 지워버리면 리포트가 쓸모없어진다
    expect(redact('/s/abc')).toBe('/s/abc')
  })

  it('평범한 문장은 건드리지 않는다', () => {
    expect(redact('업로드 실패: 용량 초과')).toBe('업로드 실패: 용량 초과')
  })
})

describe('scrub', () => {
  it('이벤트를 통째로 훑는다 (한 군데만 놓쳐도 토큰이 나간다)', () => {
    const event = {
      request: { url: `https://file.rgrg.im/s/${SHARE}` },
      breadcrumbs: [{ message: `GET /s/${SHARE}/raw` }],
      exception: { values: [{ value: `토큰 ${TOKEN} 만료` }] },
      extra: { nested: [{ deep: `/s/${SHARE}` }] },
    }

    const flat = JSON.stringify(scrub(event))

    expect(flat).not.toContain(SHARE)
    expect(flat).not.toContain(TOKEN)
    expect(flat).toContain('<share-token>')
  })

  it('문자열이 아닌 값은 그대로 둔다', () => {
    const event = { n: 1, ok: true, none: null }
    expect(scrub(event)).toEqual(event)
  })

  it('백엔드와 같은 결과를 낸다 (규칙이 갈라지면 한쪽만 새어나간다)', () => {
    // backend/app/observability.py 의 redact 와 동일한 치환이어야 한다
    expect(redact(`/s/${SHARE}`)).toBe('/s/<share-token>')
    expect(redact(TOKEN)).toBe('<api-token>')
  })
})
