import { CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import MarkdownPreview from '../components/MarkdownPreview'
import { formatBytes } from '../lib/format'
import { shareAuthHeaders } from '../lib/sharepw'
import { toggleTheme, useAppTheme } from '../lib/theme'
import {
  isAudio,
  isHtml,
  isImage,
  isMarkdown,
  isOffice,
  isPdf,
  isTextFile,
  isVideo,
} from '../lib/markdown'
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
  // 오피스·한글은 서버가 LibreOffice 로 PDF 를 만들어 준다 — 몇 초 걸릴 수 있어
  // 상태를 들고 있어야 한다(빈 화면만 보이면 고장으로 읽힌다).
  const [officeState, setOfficeState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [officeErr, setOfficeErr] = useState('')
  const [activeHeading, setActiveHeading] = useState('')
  const headRef = useRef<HTMLElement>(null)
  const tocRef = useRef<HTMLElement>(null)
  const spyPausedUntil = useRef(0)
  const [headH, setHeadH] = useState(96)

  const base = `/s/${token}`
  // 공유받은 문서는 길어도 '스크롤만' 있어서 원하는 문단으로 가기 어렵다 → 좌측 목차.
  // 목차는 **마크다운일 때만** 뽑는다. 코드 파일에도 돌리면 파이썬의 `# 주석`이
  // 제목으로 잡혀 엉뚱한 목차가 선다.
  const toc = useMemo(
    () => (text && meta && isMarkdown(meta) ? extractToc(text) : []),
    [text, meta],
  )

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
      const headers = shareAuthHeaders(password)
      // 영상·음성은 통째로 받지 않는다 — <video>/<audio> 가 주소를 직접 열어
      // 구간 요청(Range)으로 조금씩 받는다. 큰 파일을 메모리에 올리면 탭이 죽는다.
      if (isVideo(m) || isAudio(m)) return
      // 오피스·한글은 변환 결과(PDF)를 따로 받아온다.
      if (isOffice(m)) {
        setOfficeState('loading')
        setOfficeErr('')
        try {
          const r = await fetch(`${base}/preview.pdf`, { headers })
          if (!r.ok) {
            const body = (await r.json().catch(() => null)) as { detail?: string } | null
            throw new Error(body?.detail ?? `미리보기 변환 실패 (${r.status})`)
          }
          setBlobUrl(URL.createObjectURL(await r.blob()))
          setOfficeState('ready')
        } catch (err) {
          setOfficeErr(err instanceof Error ? err.message : '미리보기를 만들지 못했습니다')
          setOfficeState('error')
        }
        return
      }
      // HTML·텍스트는 글자로, 이미지·PDF 는 blob 으로.
      const wantsText = isHtml(m) || isTextFile(m)
      if (!wantsText && !isImage(m) && !isPdf(m)) return
      const res = await fetch(`${base}/raw`, { headers })
      if (!res.ok) throw new Error('unauthorized')
      if (wantsText) setText(await res.text())
      else setBlobUrl(URL.createObjectURL(await res.blob()))
    },
    [base, password],
  )

  useEffect(() => {
    if (meta && unlocked) loadPreview(meta).catch(() => setUnlocked(false))
  }, [meta, unlocked, loadPreview])

  async function unlock() {
    setPwError('')
    // 헤더를 만드는 데 실패하는 일은 이제 없지만(lib/sharepw.ts), fetch 자체가 끊길 수는
    // 있다. 잡지 않으면 '열기' 가 아무 말 없이 죽은 것처럼 보인다 — 예전에 그랬다.
    let res: Response
    try {
      res = await fetch(`${base}/raw`, { headers: shareAuthHeaders(password) })
    } catch {
      setPwError('열 수 없습니다. 잠시 후 다시 시도해 주세요.')
      return
    }
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

  // 앱 안 뷰어(ViewerPanel)와 **같은 판별**을 쓴다 — 같은 파일이 두 화면에서 다르게
  // 보이면 안 된다. 오피스·한글만 아직 빠져 있다(서버 PDF 변환이 로그인 전용이라서).
  const md = isMarkdown(meta)
  const html = isHtml(meta)
  const code = !md && !html && isTextFile(meta) // json·py·yaml… 코드블록으로 그린다
  const downloadHref = `${base}/download`
  const origin = window.location.origin
  const auth = meta.protected ? ` -u :'<비밀번호>'` : ''
  const oneCommand = `curl -fsSL ${origin}${base}/get | sh`
  const curl =
    meta.type === 'folder'
      ? `mkdir -p '${meta.name}' && curl -fL${auth} ${origin}${base}/tar | tar xzf - -C '${meta.name}'`
      : `curl -fLOJ${auth} ${origin}${base}/download`

  // 자기 레이아웃을 들고 오는 미리보기(HTML 보고서·PDF·오피스)는 **창을 다 쓴다**.
  // 900px 은 글 읽기 좋은 폭이지만, 넓은 표가 든 문서는 그 안에서 좌우로 끌어야 한다.
  const wide = html || isPdf(meta) || isOffice(meta)

  return (
    <div
      className={`share-page${toc.length > 0 ? ' has-toc' : ''}${wide ? ' is-wide' : ''}`}
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
          {md && text !== null && <MarkdownPreview text={text} />}
          {/* 코드·설정 파일은 마크다운으로 그리면 서식이 먹혀 원문이 망가진다 — 코드블록으로 */}
          {code && text !== null && (
            <MarkdownPreview text={'```' + extOf(meta.name) + '\n' + text + '\n```'} />
          )}
          {/* HTML 은 **격리해서** 보여준다. sandbox="" 면 스크립트가 돌지 않고 쿠키에도 못 닿는다.
              서버도 Content-Security-Policy: sandbox 를 함께 내려준다(이중 방어). */}
          {html && text !== null && (
            <iframe
              className="pdf-frame share-pdf"
              title={meta.name}
              sandbox=""
              referrerPolicy="no-referrer"
              srcDoc={text}
            />
          )}
          {isImage(meta) && blobUrl && (
            <div className="image-preview">
              <img src={blobUrl} alt={meta.name} />
            </div>
          )}
          {isPdf(meta) && blobUrl && (
            <iframe className="pdf-frame share-pdf" src={blobUrl} title={meta.name} />
          )}
          {/* 오피스·한글은 서버가 LibreOffice 로 만든 PDF 를 보여준다. 변환에 몇 초 걸릴 수
              있어 상태를 말해준다 — 빈 화면만 있으면 고장으로 읽힌다. */}
          {isOffice(meta) && officeState === 'loading' && (
            <p className="muted">미리보기를 만드는 중입니다… (문서가 크면 몇 초 걸립니다)</p>
          )}
          {isOffice(meta) && officeState === 'error' && (
            <p className="muted">{officeErr} — 위의 다운로드를 이용하세요.</p>
          )}
          {isOffice(meta) && officeState === 'ready' && blobUrl && (
            <iframe className="pdf-frame share-pdf" src={blobUrl} title={meta.name} />
          )}
          {/* 영상·음성은 주소를 직접 물린다 — 브라우저가 구간 요청으로 받아 바로 재생한다.
              비밀번호가 걸린 공유는 헤더를 못 실으므로 재생 대신 다운로드를 안내한다. */}
          {isVideo(meta) &&
            (meta.protected ? (
              <p className="muted">비밀번호가 걸린 영상은 재생할 수 없습니다 — 다운로드를 이용하세요.</p>
            ) : (
              // 원본(/raw)이 아니라 변환 경로를 쓴다 — 브라우저가 못 읽는 오디오 코덱(AC-3 등)이면
              // 서버가 AAC 로 바꿔 준다. 호환이면 서버가 원본을 그대로 흘려보낸다.
              <video
                className="share-media"
                src={`${base}/preview.mp4`}
                controls
                preload="metadata"
              />
            ))}
          {isAudio(meta) &&
            (meta.protected ? (
              <p className="muted">비밀번호가 걸린 음성은 재생할 수 없습니다 — 다운로드를 이용하세요.</p>
            ) : (
              <audio className="share-media" src={`${base}/raw`} controls preload="metadata" />
            ))}
          {meta.type === 'file' &&
            !md &&
            !code &&
            !html &&
            !isImage(meta) &&
            !isPdf(meta) &&
            !isVideo(meta) &&
            !isAudio(meta) &&
            !isOffice(meta) && (
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
