import { describe, expect, it } from 'vitest'
import { mappedScrollTop } from './scrollsync'

describe('mappedScrollTop', () => {
  it('같은 비율로 target scrollTop 환산', () => {
    // source: 0..500(scrollable), 절반 위치 → target 0..1000의 절반
    const src = { scrollTop: 250, scrollHeight: 1000, clientHeight: 500 }
    const tgt = { scrollHeight: 2000, clientHeight: 1000 }
    expect(mappedScrollTop(src, tgt)).toBe(500) // 0.5 * 1000
  })

  it('맨 위/맨 아래 매핑', () => {
    const tgt = { scrollHeight: 2000, clientHeight: 1000 }
    expect(mappedScrollTop({ scrollTop: 0, scrollHeight: 1000, clientHeight: 500 }, tgt)).toBe(0)
    expect(mappedScrollTop({ scrollTop: 500, scrollHeight: 1000, clientHeight: 500 }, tgt)).toBe(1000)
  })

  it('스크롤 여백 없으면 0', () => {
    const tgt = { scrollHeight: 2000, clientHeight: 1000 }
    // source가 스크롤 불가
    expect(mappedScrollTop({ scrollTop: 0, scrollHeight: 400, clientHeight: 500 }, tgt)).toBe(0)
    // target이 스크롤 불가
    expect(
      mappedScrollTop(
        { scrollTop: 100, scrollHeight: 1000, clientHeight: 500 },
        { scrollHeight: 300, clientHeight: 500 },
      ),
    ).toBe(0)
  })
})
