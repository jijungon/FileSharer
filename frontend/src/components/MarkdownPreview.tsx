import { memo, useEffect, useRef, useState } from 'react'
import Markdown, { type Components } from 'react-markdown'
import rehypeHighlight from 'rehype-highlight'
import remarkGfm from 'remark-gfm'
// 코드블록 타일은 어둡게 설계됨(styles.css: .md-preview pre = --surface-tile 배경 + --on-dark 글자).
// 라이트 테마(github.css)는 토큰을 어두운색으로 칠해 어두운 배경에 묻혀 안 보였음 → 다크 테마 사용.
import 'highlight.js/styles/github-dark.css'
import { useAppTheme } from '../lib/theme'
import { headingIdForLine } from '../lib/toc'

let mermaidSeq = 0

function MermaidBlock({ code }: { code: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const [error, setError] = useState('')
  // 다이어그램 테마를 화면 테마에 맞춘다. 'neutral'로 고정돼 있어서 다크모드에선 어두운
  // 배경 위에 어두운 글자가 그려져 라벨이 보이지 않았다(공유받은 문서에서 특히 문제).
  const appTheme = useAppTheme()

  useEffect(() => {
    let alive = true
    import('mermaid').then(async (mod) => {
      const mermaid = mod.default
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        theme: appTheme === 'dark' ? 'dark' : 'neutral',
      })
      try {
        const { svg } = await mermaid.render(`mmd-${(mermaidSeq += 1)}`, code)
        if (alive && ref.current) ref.current.innerHTML = svg
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : '다이어그램 오류')
      }
    })
    return () => {
      alive = false
    }
    // 테마가 바뀌면 다시 그린다 — 토글 즉시 반영되도록
  }, [code, appTheme])

  if (error) return <pre className="mermaid-error">mermaid: {error}</pre>
  return <div className="mermaid-block" ref={ref} />
}

/** 제목에 줄 번호 id를 단다 — 공유 페이지 목차가 이 id로 해당 문단을 찾는다(lib/toc.ts 참고). */
function headingId(node: unknown): string | undefined {
  const line = (node as { position?: { start?: { line?: number } } } | undefined)?.position?.start
    ?.line
  return line ? headingIdForLine(line) : undefined
}

/** 렌더러 매핑은 **모듈 밖에 한 번만** 만든다.
 * 이걸 JSX 안에 인라인으로 두면 렌더마다 컴포넌트 '타입'이 새로 생겨 React가 미리보기 트리를
 * 통째로 언마운트→재마운트한다. ViewerPanel이 10초마다 도는 잠금 하트비트로 setState 하므로
 * mermaid 다이어그램이 주기적으로 빈 높이로 돌아갔다 다시 그려져 화면이 튀었다. */
const COMPONENTS: Components = {
  h1: ({ node, children, ...rest }) => (
    <h1 id={headingId(node)} {...rest}>
      {children}
    </h1>
  ),
  h2: ({ node, children, ...rest }) => (
    <h2 id={headingId(node)} {...rest}>
      {children}
    </h2>
  ),
  h3: ({ node, children, ...rest }) => (
    <h3 id={headingId(node)} {...rest}>
      {children}
    </h3>
  ),
  code(props) {
    const { className, children, ...rest } = props
    const lang = /language-(\w+)/.exec(className ?? '')?.[1]
    if (lang === 'mermaid') {
      return <MermaidBlock code={String(children).trim()} />
    }
    return (
      <code className={className} {...rest}>
        {children}
      </code>
    )
  },
}

const REMARK = [remarkGfm]
const REHYPE = [rehypeHighlight]

/** GFM + 코드 하이라이트 + mermaid. raw HTML은 렌더하지 않음(XSS 차단 기본값). */
function MarkdownPreview({ text }: { text: string }) {
  return (
    <div className="md-preview">
      <Markdown remarkPlugins={REMARK} rehypePlugins={REHYPE} components={COMPONENTS}>
        {text}
      </Markdown>
    </div>
  )
}

// 내용이 그대로면 다시 그리지 않는다(마크다운 파싱은 문서가 길수록 비싸다).
export default memo(MarkdownPreview)
