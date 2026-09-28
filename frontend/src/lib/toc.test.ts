import { describe, expect, it } from 'vitest'
import { extractToc, headingIdForLine } from './toc'

describe('extractToc', () => {
  it('#/##/### 만 뽑고 줄 번호로 id를 만든다', () => {
    const md = ['# 제목', '', '본문', '## 소제목', '#### 너무 깊음', '### 세부'].join('\n')
    expect(extractToc(md)).toEqual([
      { level: 1, text: '제목', id: 'h1' },
      { level: 2, text: '소제목', id: 'h4' },
      { level: 3, text: '세부', id: 'h6' },
    ])
  })

  it('코드블록 안의 주석을 제목으로 착각하지 않는다', () => {
    const md = ['# 진짜', '', '```sh', '# 설치', '## 안쪽', '```', '', '## 진짜2'].join('\n')
    expect(extractToc(md).map((t) => t.text)).toEqual(['진짜', '진짜2'])
  })

  it('표시용 텍스트에서 인라인 서식을 벗긴다', () => {
    const md = '## **굵게** `코드` [링크](https://example.com)'
    expect(extractToc(md)[0].text).toBe('굵게 코드 링크')
  })

  it('# 뒤에 공백이 없으면 제목이 아니다 (#태그 오인 방지)', () => {
    expect(extractToc('#태그아님\n\n## 맞음')).toEqual([{ level: 2, text: '맞음', id: 'h3' }])
  })

  it('id 규칙은 렌더러와 공유한다', () => {
    expect(headingIdForLine(12)).toBe('h12')
  })
})
