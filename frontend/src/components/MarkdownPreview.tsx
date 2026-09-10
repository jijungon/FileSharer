import { useEffect, useRef, useState } from 'react'
import Markdown from 'react-markdown'
import rehypeHighlight from 'rehype-highlight'
import remarkGfm from 'remark-gfm'
import 'highlight.js/styles/github.css'

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
