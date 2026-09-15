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
})
