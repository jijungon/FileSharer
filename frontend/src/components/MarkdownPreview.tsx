import { useEffect, useRef, useState } from 'react'
import Markdown from 'react-markdown'
import rehypeHighlight from 'rehype-highlight'
import remarkGfm from 'remark-gfm'
// 코드블록 타일은 어둡게 설계됨(styles.css: .md-preview pre = --surface-tile 배경 + --on-dark 글자).
// 라이트 테마(github.css)는 토큰을 어두운색으로 칠해 어두운 배경에 묻혀 안 보였음 → 다크 테마 사용.
import 'highlight.js/styles/github-dark.css'

let mermaidSeq = 0

function MermaidBlock({ code }: { code: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let alive = true
    import('mermaid').then(async (mod) => {
      const mermaid = mod.default
      mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'neutral' })
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
  }, [code])

  if (error) return <pre className="mermaid-error">mermaid: {error}</pre>
  return <div className="mermaid-block" ref={ref} />
}

/** GFM + 코드 하이라이트 + mermaid. raw HTML은 렌더하지 않음(XSS 차단 기본값). */
export default function MarkdownPreview({ text }: { text: string }) {
  return (
    <div className="md-preview">
      <Markdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={{
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
        }}
      >
        {text}
      </Markdown>
    </div>
  )
}
