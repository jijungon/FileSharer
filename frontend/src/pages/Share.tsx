import { CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import MarkdownPreview from '../components/MarkdownPreview'
import { formatBytes } from '../lib/format'
import { toggleTheme, useAppTheme } from '../lib/theme'
import { extractToc } from '../lib/toc'

interface ShareMeta {
  name: string
  type: 'file' | 'folder'
  size: number
  mime: string
  protected: boolean
  expires_at: string
}

function extOf(name: string) {
  const i = name.lastIndexOf('.')
  return i === -1 ? '' : name.slice(i + 1).toLowerCase()
}

export default function Share() {
  const { token } = useParams()
  const theme = useAppTheme() // 토글하면 <html data-theme> 변화를 구독해 자동 반영
  const [meta, setMeta] = useState<ShareMeta | null>(null)
  const [gone, setGone] = useState('')
  const [password, setPassword] = useState('')
  const [unlocked, setUnlocked] = useState(false)
  const [pwError, setPwError] = useState('')
  const [text, setText] = useState<string | null>(null)
  const [blobUrl, setBlobUrl] = useState('')
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [activeHeading, setActiveHeading] = useState('')
  const headRef = useRef<HTMLElement>(null)
  const tocRef = useRef<HTMLElement>(null)
  const spyPausedUntil = useRef(0)
  const [headH, setHeadH] = useState(96)

  const base = `/s/${token}`
  // 공유받은 문서는 길어도 '스크롤만' 있어서 원하는 문단으로 가기 어렵다 → 좌측 목차.
  const toc = useMemo(() => (text ? extractToc(text) : []), [text])

  function jumpTo(id: string) {
    const el = document.getElementById(id)
    if (!el) return
    setActiveHeading(id)
    // 부드럽게 스크롤하는 동안 중간 문단들이 스쳐 지나가며 목차가 깜빡이지 않게 잠시 멈춘다
    spyPausedUntil.current = Date.now() + 800
    el.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  // 지금 보고 있는 문단을 목차에 표시한다 — 고정 헤더 바로 아래를 기준선으로 삼아,
  // 그 선을 지나간 제목 중 마지막 것이 '현재 문단'이다.
  useEffect(() => {
    if (toc.length === 0) return
    let raf = 0
    const update = () => {
      raf = 0
      if (Date.now() < spyPausedUntil.current) return
      const line = headH + 24
      let current = toc[0].id
      for (const item of toc) {
        const el = document.getElementById(item.id)
        if (!el) continue
        if (el.getBoundingClientRect().top > line) break // 제목은 문서 순서대로다
        current = item.id
      }
      // 맨 아래에 닿으면 마지막 항목 — 마지막 문단이 짧으면 기준선을 못 넘어 영영 표시가 안 된다
      if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2) {
        current = toc[toc.length - 1].id
      }
      setActiveHeading((prev) => (prev === current ? prev : current))
    }
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(update)
    }
    update()
    window.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onScroll)
    return () => {
      window.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onScroll)
      if (raf) cancelAnimationFrame(raf)
    }
  }, [toc, headH])

  // 목차가 길면 현재 항목이 목차 안에서 스크롤 밖으로 나간다 — 목차만 따라 움직인다
  useEffect(() => {
    const nav = tocRef.current
    if (!nav || !activeHeading) return
    const el = nav.querySelector<HTMLElement>(`[data-toc-id="${activeHeading}"]`)
    if (!el) return
    const top = el.offsetTop
    const bottom = top + el.offsetHeight
    if (top < nav.scrollTop) nav.scrollTop = top - 8
    else if (bottom > nav.scrollTop + nav.clientHeight) nav.scrollTop = bottom - nav.clientHeight + 8
  }, [activeHeading])

  // 고정 헤더 높이를 재서 CSS에 넘긴다 — 파일명이 길면 헤더가 두 줄이 되므로 상수로 박으면
  // 목차가 헤더 밑에 깔리거나(가림), 문단으로 건너뛸 때 제목이 헤더에 가려진다.
  useEffect(() => {
    const el = headRef.current
    if (!el) return
    const measure = () => setHeadH(el.offsetHeight)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [meta])

  useEffect(() => {
    fetch(`${base}/meta`).then(async (res) => {
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        setGone(body?.detail ?? '링크를 열 수 없습니다')
        return
      }
      const m = (await res.json()) as ShareMeta
      setMeta(m)
      if (!m.protected) setUnlocked(true)
    })
  }, [base])

  const loadPreview = useCallback(
    async (m: ShareMeta) => {
      if (m.type !== 'file') return
      const headers: Record<string, string> = password ? { 'X-Share-Password': password } : {}
      const isMd = ['md', 'markdown', 'txt'].includes(extOf(m.name))
      const isImg = m.mime.startsWith('image/')
      const isPdf = m.mime === 'application/pdf' || extOf(m.name) === 'pdf'
      if (!isMd && !isImg && !isPdf) return
      const res = await fetch(`${base}/raw`, { headers })
      if (!res.ok) throw new Error('unauthorized')
      if (isMd) setText(await res.text())
      else setBlobUrl(URL.createObjectURL(await res.blob()))
    },
    [base, password],
  )

  useEffect(() => {
    if (meta && unlocked) loadPreview(meta).catch(() => setUnlocked(false))
  }, [meta, unlocked, loadPreview])

  async function unlock() {
    setPwError('')
    const res = await fetch(`${base}/raw`, { headers: { 'X-Share-Password': password } })
    if (res.status === 401) {
      setPwError('비밀번호가 올바르지 않습니다')
      return
    }
    setUnlocked(true)
  }

  if (gone)
    return (
      <div className="login-page">
        <div className="login-card">
          <h1>🔗</h1>
          <p>{gone}</p>
        </div>
      </div>
    )

  if (!meta) return null

  if (meta.protected && !unlocked)
    return (
      <div className="login-page">
        <div className="login-card">
          <h1>🔒</h1>
          <p className="tagline">비밀번호가 걸린 공유입니다</p>
          <div className="login-local">
            <input
              type="password"
              placeholder="비밀번호"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && unlock()}
            />
            <button className="btn-primary" onClick={unlock}>
              열기
            </button>
            <div className="login-error">{pwError}</div>
          </div>
        </div>
      </div>
    )

  const isMd = ['md', 'markdown', 'txt'].includes(extOf(meta.name))
  const isImg = meta.mime.startsWith('image/')
  const isPdf = meta.mime === 'application/pdf' || extOf(meta.name) === 'pdf'
  const downloadHref = `${base}/download`
  const origin = window.location.origin
  const auth = meta.protected ? ` -u :'<비밀번호>'` : ''
  const oneCommand = `curl -fsSL ${origin}${base}/get | sh`
  const curl =
    meta.type === 'folder'
      ? `mkdir -p '${meta.name}' && curl -fL${auth} ${origin}${base}/tar | tar xzf - -C '${meta.name}'`
      : `curl -fLOJ${auth} ${origin}${base}/download`

  return (
    <div
      className={`share-page${toc.length > 0 ? ' has-toc' : ''}`}
      style={{ '--share-head-h': `${headH}px` } as CSSProperties}
    >
      <header className="share-page-head" ref={headRef}>
        <div>
          <h2>{meta.type === 'folder' ? '📁' : '📄'} {meta.name}</h2>
          <span className="muted">
            {meta.type === 'file' ? formatBytes(meta.size) : '폴더 (tar.gz로 받아집니다)'} · 만료{' '}
            {meta.expires_at.slice(0, 10)}
          </span>
        </div>
        {/* 공유받은 사람도 보기 편한 모드를 고를 수 있어야 한다(다크에서 다이어그램·본문 대비) */}
        <div className="share-page-actions">
          <button
            className="btn-utility theme-toggle"
            onClick={() => toggleTheme()}
            title={theme === 'dark' ? '라이트 모드로 전환' : '다크 모드로 전환'}
            aria-label="테마 전환"
          >
            {theme === 'dark' ? '☀︎' : '☾'}
          </button>
          <a href={downloadHref}>
            <button className="btn-primary">다운로드</button>
          </a>
        </div>
      </header>

      <div className="share-main">
        {toc.length > 0 && (
          <nav className="share-toc" aria-label="목차" ref={tocRef}>
            <div className="share-toc-title">목차</div>
            {toc.map((item) => (
              <button
                key={item.id}
                data-toc-id={item.id}
                className={`share-toc-item lv${item.level}${activeHeading === item.id ? ' active' : ''}`}
                onClick={() => jumpTo(item.id)}
                title={item.text}
                aria-current={activeHeading === item.id ? 'true' : undefined}
              >
                {item.text}
              </button>
            ))}
          </nav>
        )}

        <main className="share-page-body">
          {isMd && text !== null && <MarkdownPreview text={text} />}
          {isImg && blobUrl && (
            <div className="image-preview">
              <img src={blobUrl} alt={meta.name} />
            </div>
          )}
          {isPdf && blobUrl && <iframe className="pdf-frame share-pdf" src={blobUrl} title={meta.name} />}
          {meta.type === 'file' && !isMd && !isImg && !isPdf && (
            <p className="muted">미리보기를 지원하지 않는 형식입니다 — 위의 다운로드를 이용하세요.</p>
          )}
          {meta.type === 'folder' && (
            <p className="muted">폴더 공유입니다. 다운로드 버튼을 누르면 tar.gz로 받아집니다.</p>
          )}

          <button className="login-local-toggle" onClick={() => setShowAdvanced((v) => !v)}>
            {showAdvanced ? '고급 명령 접기' : '고급: 터미널(VM)에서 받기'}
          </button>
          {showAdvanced && (
            <pre className="share-curl">
              {`# 원커맨드 (다운로드+해제+검증)\n${oneCommand}`}
              {meta.protected ? '\n# 🔒 실행하면 비밀번호를 물어봅니다 (또는 끝에  | SHARE_PW=<비번> sh)' : ''}
              {`\n\n# 수동\n${curl}`}
            </pre>
          )}
        </main>
      </div>
    </div>
  )
}
