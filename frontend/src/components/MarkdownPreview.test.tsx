import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import MarkdownPreview from './MarkdownPreview'
import markdownPreviewSource from './MarkdownPreview.tsx?raw'

describe('MarkdownPreview 코드블록', () => {
  it('펜스 코드블록이 hljs 하이라이트로 렌더된다', () => {
    const { container } = render(<MarkdownPreview text={'```js\nconst answer = 42\n```'} />)
    const code = container.querySelector('pre code')
    expect(code).not.toBeNull()
    expect(code?.className).toContain('hljs') // rehype-highlight 적용 확인
    expect(container.textContent).toContain('answer')
  })

  it('하이라이트 테마는 dark 여야 한다 (어두운 코드 타일 가독성 회귀 방지)', () => {
    // .md-preview pre 는 어두운 배경(--surface-tile)+밝은 글자(--on-dark)로 설계됨.
    // 라이트 테마(github.css)면 토큰이 어두운색이라 어두운 배경에 묻혀 안 보임(과거 버그).
    expect(markdownPreviewSource).toMatch(/highlight\.js\/styles\/github-dark(-dimmed)?(\.min)?\.css/)
    expect(markdownPreviewSource).not.toMatch(/highlight\.js\/styles\/github\.css/) // 라이트 재도입 방지
  })

  it('같은 내용으로 다시 렌더해도 DOM을 갈아끼우지 않는다 (화면 튐 회귀 방지)', () => {
    // ViewerPanel은 10초마다 잠금 하트비트로 setState 한다. 그때마다 미리보기 트리가
    // 통째로 재마운트되면 mermaid 블록이 빈 높이로 돌아갔다가 다시 그려져 화면이 튄다.
    const md = '# 제목\n\n```mermaid\ngraph TD; A-->B;\n```\n\n본문'
    const { container, rerender } = render(<MarkdownPreview text={md} />)
    const before = container.querySelector('.mermaid-block')
    const beforeP = container.querySelector('p')
    rerender(<MarkdownPreview text={md} />)
    expect(container.querySelector('.mermaid-block')).toBe(before)
    expect(container.querySelector('p')).toBe(beforeP)
  })

  it('제목에 줄 번호 id가 붙는다 (공유 페이지 목차가 이 id로 문단을 찾는다)', () => {
    const { container } = render(<MarkdownPreview text={'# 처음\n\n본문\n\n## 둘째\n\n### 셋째'} />)
    // lib/toc.ts 의 extractToc 가 계산하는 id(h<줄번호>)와 정확히 같아야 한다.
    expect(container.querySelector('h1')?.id).toBe('h1')
    expect(container.querySelector('h2')?.id).toBe('h5')
    expect(container.querySelector('h3')?.id).toBe('h7')
  })
})
