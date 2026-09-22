import { markdown } from '@codemirror/lang-markdown'
import CodeMirror, { EditorView } from '@uiw/react-codemirror'
import { useScrollSync } from '../lib/scrollsync'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { ApiError, SpaceInfo } from '../lib/api'
import SharePopover from './SharePopover'
import ServerUploadPopover from './ServerUploadPopover'
import { acquireLock, downloadUrl, LockState, NodeInfo, releaseLock } from '../lib/files'
import { formatBytes } from '../lib/format'

// DnX풍 다크 에디터 테마 (near-black base + 골드 커서/활성줄)
const EDITOR_DARK = EditorView.theme(
  {
    '&': { color: '#dedce4', backgroundColor: '#131315' },
    '.cm-content': { caretColor: '#cba85a', padding: '8px 0' },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: '#cba85a' },
    '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, .cm-content ::selection': {
      backgroundColor: '#3a3427',
    },
    '.cm-gutters': { backgroundColor: '#131315', color: '#57565d', border: 'none' },
    '.cm-activeLine': { backgroundColor: 'rgba(203, 168, 90, 0.045)' },
    '.cm-activeLineGutter': { backgroundColor: 'rgba(203, 168, 90, 0.05)', color: '#cba85a' },
    '.cm-selectionMatch': { backgroundColor: 'rgba(203, 168, 90, 0.14)' },
  },
  { dark: true },
)

// 라이트 모드 에디터 테마 (흰 바탕 + 진한 골드 커서/활성줄, 어두운 글자로 대비 확보)
const EDITOR_LIGHT = EditorView.theme(
  {
    '&': { color: '#1d1d1f', backgroundColor: '#ffffff' },
    '.cm-content': { caretColor: '#9a7526', padding: '8px 0' },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: '#9a7526' },
    '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, .cm-content ::selection': {
      backgroundColor: '#ece0c4',
    },
    '.cm-gutters': { backgroundColor: '#ffffff', color: '#adacb4', border: 'none' },
    '.cm-activeLine': { backgroundColor: 'rgba(154, 117, 38, 0.06)' },
    '.cm-activeLineGutter': { backgroundColor: 'rgba(154, 117, 38, 0.09)', color: '#9a7526' },
    '.cm-selectionMatch': { backgroundColor: 'rgba(154, 117, 38, 0.18)' },
  },
  { dark: false },
)
import {
  fetchText,
  isAudio,
  isHtml,
  isImage,
  isMarkdown,
  isOffice,
  isPdf,
  isTextFile,
  isVideo,
  saveContent,
  SUPPORTED_PREVIEW,
} from '../lib/markdown'
import MarkdownPreview from './MarkdownPreview'

const AUTOSAVE_KEY = 'filesharer.autosave'
const MAX_EDIT_BYTES = 5 * 1024 * 1024

// 현재 앱 테마(라이트/다크)를 구독한다. Files.tsx의 토글이 <html data-theme>를 바꾸므로
// 에디터가 열려 있는 동안 토글해도 즉시 반영되도록 MutationObserver로 감시한다.
function useAppTheme(): 'light' | 'dark' {
  const [theme, setTheme] = useState<'light' | 'dark'>(() =>
    typeof document !== 'undefined' && document.documentElement.dataset.theme === 'light'
      ? 'light'
      : 'dark',
  )
  useEffect(() => {
    const el = document.documentElement
    const obs = new MutationObserver(() =>
      setTheme(el.dataset.theme === 'light' ? 'light' : 'dark'),
    )
    obs.observe(el, { attributes: true, attributeFilter: ['data-theme'] })
    return () => obs.disconnect()
  }, [])
  return theme
}

interface Props {
  node: NodeInfo
  space: SpaceInfo | null
  path: NodeInfo[]
  onNavigate: (index: number | null) => void
  fullscreen: boolean
  onToggleFullscreen: () => void
  onNodeUpdated: (fresh: NodeInfo) => void
  onClose: () => void
  activeToken?: string | null // 방금 발급한 토큰 — 서버 업로드 curl 자동 채움
  onActiveToken: (token: string | null) => void // 임시 토큰 발급/해제 반영
  onLocalUpload?: () => void // 내 PC에서 현재 위치로 업로드(파일 선택창 열기)
}

// 편집/미리보기 상단 경로(예전 LinkBar의 브레드크럼). 파일을 열면 LinkBar를 숨기고
// 이 경로를 에디터 툴바에 넣어 한 줄로 통합한다(폴더 클릭 시 그 폴더로 이동 → 뷰어 닫힘).
function CrumbPath({
  space,
  path,
  onNavigate,
}: {
  space: SpaceInfo | null
  path: NodeInfo[]
  onNavigate: (index: number | null) => void
}) {
  return (
    <nav className="editor-crumbs" aria-label="경로">
      <button className="crumb" onClick={() => onNavigate(null)}>
        {space?.name ?? '…'}
      </button>
      {path.map((folder, i) => (
        <span key={folder.id} className="editor-crumb-seg">
          <span className="crumb-sep">/</span>
          <button className="crumb" onClick={() => onNavigate(i)}>
            {folder.name}
          </button>
        </span>
      ))}
    </nav>
  )
}

// 파일 액션(다운로드 · 서버 업로드 · 사내 링크 복사 · 공유 링크) — 예전 LinkBar에서 옮겨왔다.
// 서버 업로드는 '이 파일이 있는 폴더'가 대상(파일 자체가 아니라 폴더로 push). 공유 링크 바로 옆.
function FileActions({
  node,
  space,
  path,
  activeToken,
  onActiveToken,
  onLocalUpload,
}: {
  node: NodeInfo
  space: SpaceInfo | null
  path: NodeInfo[]
  activeToken?: string | null
  onActiveToken: (token: string | null) => void
  onLocalUpload?: () => void
}) {
  const [copied, setCopied] = useState(false)
  const [shareOpen, setShareOpen] = useState(false)
  const [serverUpOpen, setServerUpOpen] = useState(false)
  async function copyInternalLink() {
    await navigator.clipboard.writeText(`${window.location.origin}/files/${node.id}`)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }
  const folder = path.length > 0 ? path[path.length - 1] : null
  return (
    <>
      {/* 로컬: 다운로드 · 로컬 업로드 (연한 노랑) */}
      <a href={downloadUrl(node)}>
        <button className="btn-utility btn-tier-local">다운로드</button>
      </a>
      {onLocalUpload && (
        <button
          className="btn-utility btn-tier-local"
          onClick={onLocalUpload}
          title="내 PC에서 이 파일의 폴더로 업로드 (폴더는 끌어다 놓기)"
        >
          ↑ 로컬 업로드
        </button>
      )}
      <span className="action-divider" aria-hidden="true" />
      {/* 서버(헤드리스) 업로드 (중간 노랑) */}
      {space && (
        <button
          className="btn-utility btn-tier-server"
          onClick={() => {
            setServerUpOpen((v) => !v)
            setShareOpen(false)
          }}
          title="이 폴더로 서버에서 파일 올리기 (API 토큰)"
        >
          ↥ 서버 업로드
        </button>
      )}
      {/* 링크: 사내 링크 복사 · 공유 링크 (진한 노랑) — 서버와는 색으로만 구분(선 없음) */}
      <button className="btn-utility btn-tier-link" onClick={copyInternalLink}>
        {copied ? '복사됨 ✓' : '사내 링크 복사'}
      </button>
      <button
        className="btn-utility btn-tier-link linkbar-share"
        onClick={() => {
          setShareOpen((v) => !v)
          setServerUpOpen(false)
        }}
      >
        공유 링크
      </button>
      {serverUpOpen && space && (
        <ServerUploadPopover
          folderId={folder?.id ?? null}
          spaceId={space.id}
          label={folder?.name ?? space.name}
          activeToken={activeToken}
          onActiveToken={onActiveToken}
          onClose={() => setServerUpOpen(false)}
        />
      )}
      {shareOpen && <SharePopover node={node} onClose={() => setShareOpen(false)} />}
    </>
  )
}

// 뷰어/에디터 공통 상단 툴바. children = 형식별 컨트롤(자동저장·저장 등).
// 사용자 요청대로 다운로드/링크 버튼을 저장 '왼쪽'에 두려고 파일 액션을 children 앞에 놓는다.
function ViewerToolbar({
  node,
  space,
  path,
  onNavigate,
  fullscreen,
  onToggleFullscreen,
  onClose,
  name,
  status,
  statusClass,
  extraStatus,
  activeToken,
  onActiveToken,
  onLocalUpload,
  children,
}: {
  node: NodeInfo
  space: SpaceInfo | null
  path: NodeInfo[]
  onNavigate: (index: number | null) => void
  fullscreen: boolean
  onToggleFullscreen: () => void
  onClose: () => void
  name?: ReactNode
  status?: ReactNode
  statusClass?: string
  extraStatus?: ReactNode
  activeToken?: string | null
  onActiveToken: (token: string | null) => void
  onLocalUpload?: () => void
  children?: ReactNode
}) {
  return (
    <div className="editor-toolbar">
      <CrumbPath space={space} path={path} onNavigate={onNavigate} />
      <span className="editor-name">{name ?? node.name}</span>
      {status != null && (
        <span className={`editor-status${statusClass ? ` ${statusClass}` : ''}`}>{status}</span>
      )}
      {extraStatus}
      <span className="toolbar-spacer" />
      <FileActions
        node={node}
        space={space}
        path={path}
        activeToken={activeToken}
        onActiveToken={onActiveToken}
        onLocalUpload={onLocalUpload}
      />
      {children}
      <button className="btn-utility" onClick={onToggleFullscreen}>
        {fullscreen ? '분할 보기' : '전체화면'}
      </button>
      <button className="btn-utility" onClick={onClose}>
        닫기
      </button>
    </div>
  )
}

export default function ViewerPanel(props: Props) {
  // HTML은 text/*라 편집기보다 먼저 잡아 렌더한다 (소스가 아닌 보기 모드)
  if (isHtml(props.node)) return <MediaPreview {...props} kind="html" key={props.node.id} />
  if (isTextFile(props.node)) return <TextEditor {...props} key={props.node.id} />
  if (isImage(props.node)) return <MediaPreview {...props} kind="image" key={props.node.id} />
  if (isPdf(props.node)) return <MediaPreview {...props} kind="pdf" key={props.node.id} />
  if (isVideo(props.node)) return <MediaPreview {...props} kind="video" key={props.node.id} />
  if (isAudio(props.node)) return <MediaPreview {...props} kind="audio" key={props.node.id} />
  if (isOffice(props.node)) return <OfficePreview {...props} key={props.node.id} />
  return <DownloadCard {...props} />
}

type MediaKind = 'image' | 'pdf' | 'video' | 'audio' | 'html'

function MediaPreview({
  node,
  space,
  path,
  onNavigate,
  onClose,
  kind,
  fullscreen,
  onToggleFullscreen,
  activeToken,
  onActiveToken,
  onLocalUpload,
}: Props & { kind: MediaKind }) {
  const raw = `/api/files/${node.id}/raw`
  // 영상 재생은 preview.mp4로 — 브라우저가 못 푸는 오디오 코덱(AC-3 등)이면 서버가 AAC로 변환해 준다.
  const videoSrc = `/api/files/${node.id}/preview.mp4`
  return (
    <div className="editor-shell">
      <ViewerToolbar
        node={node}
        space={space}
        path={path}
        onNavigate={onNavigate}
        fullscreen={fullscreen}
        onToggleFullscreen={onToggleFullscreen}
        onClose={onClose}
        activeToken={activeToken}
        onActiveToken={onActiveToken}
        onLocalUpload={onLocalUpload}
        status={formatBytes(node.size)}
        extraStatus={
          kind === 'html' ? (
            <span
              className="editor-status"
              title="업로드된 HTML은 보안을 위해 스크립트 없이 표시됩니다"
            >
              HTML · 스크립트 미실행
            </span>
          ) : undefined
        }
      />
      {kind === 'image' ? (
        <div className="image-preview">
          <img src={raw} alt={node.name} />
        </div>
      ) : kind === 'video' ? (
        <div className="media-preview">
          <video src={videoSrc} controls preload="metadata" />
        </div>
      ) : kind === 'audio' ? (
        <div className="media-preview audio">
          <audio src={raw} controls preload="metadata" />
        </div>
      ) : kind === 'html' ? (
        <HtmlFrame node={node} />
      ) : (
        <iframe className="pdf-frame" src={raw} title={node.name} />
      )}
    </div>
  )
}

/** HTML 미리보기 — 원본을 받아 srcdoc으로 격리(sandbox) 렌더한다.
 * 인증된 URL을 iframe src로 바로 여는 방식은 프레임 요청이 차단될 수 있어,
 * 텍스트로 받아 srcdoc에 넣는다(스크립트 미실행, 동일출처 접근 차단). */
function HtmlFrame({ node }: { node: NodeInfo }) {
  const [html, setHtml] = useState<string | null>(null)
  const [err, setErr] = useState('')
  useEffect(() => {
    let alive = true
    fetchText(node.id)
      .then((t) => alive && setHtml(t))
      .catch((e) => alive && setErr(e instanceof Error ? e.message : '불러오기 실패'))
    return () => {
      alive = false
    }
  }, [node.id])
  if (err) return <div className="viewer-card-wrap"><p className="muted">{err}</p></div>
  if (html === null) return <div className="viewer-card-wrap"><p className="muted">불러오는 중…</p></div>
  return (
    <iframe
      className="pdf-frame"
      title={node.name}
      sandbox=""
      referrerPolicy="no-referrer"
      srcDoc={html}
    />
  )
}

/** 오피스 문서 미리보기 — 서버가 LibreOffice로 변환한 PDF를 받아 보여준다.
 * 변환에 몇 초 걸릴 수 있어 로딩 상태를 표시하고, 실패하면 안내한다. */
function OfficePreview({
  node,
  space,
  path,
  onNavigate,
  onClose,
  fullscreen,
  onToggleFullscreen,
  activeToken,
  onActiveToken,
  onLocalUpload,
}: Props) {
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [pdfUrl, setPdfUrl] = useState('')
  const [err, setErr] = useState('')
  useEffect(() => {
    let alive = true
    let objUrl = ''
    setState('loading')
    fetch(`/api/files/${node.id}/preview.pdf`)
      .then(async (r) => {
        if (!r.ok) {
          const body = (await r.json().catch(() => null)) as { detail?: string } | null
          throw new Error(body?.detail ?? `미리보기 변환 실패 (${r.status})`)
        }
        return r.blob()
      })
      .then((blob) => {
        if (!alive) return
        objUrl = URL.createObjectURL(blob)
        setPdfUrl(objUrl)
        setState('ready')
      })
      .catch((e) => {
        if (!alive) return
        setErr(e instanceof Error ? e.message : '미리보기 변환 실패')
        setState('error')
      })
    return () => {
      alive = false
      if (objUrl) URL.revokeObjectURL(objUrl)
    }
  }, [node.id])

  return (
    <div className="editor-shell">
      <ViewerToolbar
        node={node}
        space={space}
        path={path}
        onNavigate={onNavigate}
        fullscreen={fullscreen}
        onToggleFullscreen={onToggleFullscreen}
        onClose={onClose}
        activeToken={activeToken}
        onActiveToken={onActiveToken}
        onLocalUpload={onLocalUpload}
        status={formatBytes(node.size)}
        extraStatus={<span className="editor-status">PDF로 변환됨</span>}
      />
      {state === 'loading' ? (
        <div className="viewer-card-wrap">
          <p className="muted">PDF로 변환하는 중… (처음 한 번은 몇 초 걸릴 수 있어요)</p>
        </div>
      ) : state === 'error' ? (
        <div className="viewer-card-wrap">
          <div className="viewer-card">
            <div className="viewer-card-icon">📄</div>
            <div className="viewer-card-body">
              <div className="viewer-card-name">{node.name}</div>
              <div className="muted">{err}</div>
            </div>
            <a href={downloadUrl(node)}>
              <button className="btn-primary">원본 다운로드</button>
            </a>
          </div>
        </div>
      ) : (
        <iframe className="pdf-frame" src={pdfUrl} title={node.name} />
      )}
    </div>
  )
}

function DownloadCard({ node, onClose }: Props) {
  return (
    <div className="viewer-card-wrap">
      <div className="viewer-card">
        <div className="viewer-card-icon">📄</div>
        <div className="viewer-card-body">
          <div className="viewer-card-name">{node.name}</div>
          <div className="muted">
            {formatBytes(node.size)} · 미리보기를 지원하지 않는 형식입니다
          </div>
          <details className="supported-formats">
            <summary>미리보기 지원 형식 보기</summary>
            <ul>
              {SUPPORTED_PREVIEW.map((f) => (
                <li key={f.label}>
                  <b>{f.label}</b> <span className="muted">{f.exts}</span>
                </li>
              ))}
            </ul>
          </details>
        </div>
        <a href={downloadUrl(node)}>
          <button className="btn-primary">다운로드</button>
        </a>
        <button className="btn-utility" onClick={onClose}>
          닫기
        </button>
      </div>
    </div>
  )
}

function TextEditor({
  node,
  space,
  path,
  onNavigate,
  fullscreen,
  onToggleFullscreen,
  onNodeUpdated,
  onClose,
  activeToken,
  onActiveToken,
  onLocalUpload,
}: Props) {
  const appTheme = useAppTheme() // 라이트/다크 토글에 따라 에디터 테마도 전환
  const [text, setText] = useState<string | null>(null)
  const [loadError, setLoadError] = useState('')
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [savedFlash, setSavedFlash] = useState(false)
  const [conflict, setConflict] = useState(false)
  // 편집 잠금 상태(null=확인 전). held_by_me면 내가 편집 중, 아니면 holder가 편집 중 → 읽기 전용.
  const [lock, setLock] = useState<LockState | null>(null)
  const [autosave, setAutosave] = useState(() => {
    try {
      return localStorage.getItem(AUTOSAVE_KEY) === 'on'
    } catch {
      return false
    }
  })
  const [split, setSplit] = useState(50) // 편집기 % 폭
  const editorPaneRef = useRef<HTMLDivElement>(null)
  const previewRef = useRef<HTMLDivElement>(null)
  const baseStamp = useRef<string | null>(node.updated_at)
  const textRef = useRef('')
  const savedTextRef = useRef('') // 마지막으로 저장된(=서버와 같은) 내용. 이거랑 같으면 저장할 게 없음
  const autosaveTimer = useRef<number | undefined>(undefined)
  const canEditRef = useRef(true) // 잠금 미보유(읽기 전용)면 false — doSave 가드용(스테일 클로저 방지)

  // 문서 로드
  useEffect(() => {
    if (node.size > MAX_EDIT_BYTES) {
      setLoadError('문서가 너무 커서 편집기로 열 수 없습니다 (5MB 제한)')
      return
    }
    fetchText(node.id)
      .then((t) => {
        setText(t)
        textRef.current = t
        savedTextRef.current = t // 로드 직후 = 서버와 동일 → 저장 버튼 비활성
      })
      .catch((e) => setLoadError(e instanceof Error ? e.message : '불러오기 실패'))
  }, [node.id, node.size])

  // 남이 편집 중이면 읽기 전용. (잠금 확인 전 null은 편집 가능으로 두되 아래 획득이 곧 확정)
  const readOnly = lock !== null && !lock.held_by_me
  useEffect(() => {
    canEditRef.current = !readOnly
  }, [readOnly])

  // 편집 잠금: 열면 획득, 10초마다 하트비트(겸 남의 잠금 만료 시 인수), 닫으면 해제.
  useEffect(() => {
    let alive = true
    let prevHeld: boolean | null = null
    async function beat() {
      try {
        const s = await acquireLock(node.id)
        if (!alive) return
        // 읽기전용→편집가능(잠금 인수)으로 바뀌면 서버 최신으로 새로고침 — 낡은 내용 위 편집 방지
        if (prevHeld === false && s.held_by_me) {
          const t = await fetchText(node.id).catch(() => null)
          if (t !== null && alive) {
            setText(t)
            textRef.current = t
            savedTextRef.current = t
            baseStamp.current = null
            setDirty(false)
            setConflict(false)
          }
        }
        prevHeld = s.held_by_me
        setLock(s)
      } catch {
        /* 네트워크 순단 — 다음 주기에 재시도. 잠금 상태는 유지 */
      }
    }
    beat()
    const timer = window.setInterval(beat, 10000)
    return () => {
      alive = false
      window.clearInterval(timer)
      releaseLock(node.id) // 닫기/전환 시 해제(그래도 못 가면 서버 TTL이 정리)
    }
  }, [node.id])

  // 탭 닫기·새로고침 등 이탈 시에도 잠금 해제(sendBeacon)
  useEffect(() => {
    const onLeave = () => releaseLock(node.id)
    window.addEventListener('pagehide', onLeave)
    return () => window.removeEventListener('pagehide', onLeave)
  }, [node.id])

  const doSave = useCallback(
    async (force = false) => {
      if (saving) return
      if (!canEditRef.current) return // 읽기 전용(잠금 미보유)이면 저장 금지
      const snapshot = textRef.current // 저장 시점 내용 스냅샷
      // 저장 전후가 동일하면(변경 없음) 저장 자체를 건너뛴다 — 불필요한 no-op 저장 방지.
      // (수동 저장 버튼은 아래 dirty로 비활성화되지만, autosave 타이머·Cmd+S 경로도 함께 막는다.)
      if (!force && snapshot === savedTextRef.current) return
      setSaving(true)
      try {
        const fresh = await saveContent(node.id, snapshot, force ? null : baseStamp.current)
        baseStamp.current = fresh.updated_at
        savedTextRef.current = snapshot
        setDirty(textRef.current !== snapshot) // 저장 중 추가 입력이 있었으면 여전히 dirty
        setConflict(false)
        setSavedFlash(true)
        setTimeout(() => setSavedFlash(false), 1500)
        onNodeUpdated(fresh)
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) setConflict(true)
      } finally {
        setSaving(false)
      }
    },
    [node.id, onNodeUpdated, saving],
  )

  // Cmd/Ctrl+S — autosave 토글과 무관하게 항상 동작
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        doSave()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [doSave])

  // 미저장 이탈 경고
  useEffect(() => {
    function onBeforeUnload(e: BeforeUnloadEvent) {
      if (dirty) e.preventDefault()
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [dirty])

  function onChange(value: string) {
    textRef.current = value
    setText(value)
    // 저장된 내용과 실제로 다를 때만 dirty=true. 입력했다가 원래대로 되돌리면
    // dirty=false가 되어 저장 버튼이 다시 비활성화된다(저장 전후 동일 → 저장 불가).
    setDirty(value !== savedTextRef.current)
    if (autosave && !conflict) {
      window.clearTimeout(autosaveTimer.current)
      autosaveTimer.current = window.setTimeout(() => doSave(), 2500)
    }
  }

  function toggleAutosave() {
    const next = !autosave
    setAutosave(next)
    try {
      localStorage.setItem(AUTOSAVE_KEY, next ? 'on' : 'off')
    } catch {
      /* localStorage 불가 환경 무시 */
    }
  }

  async function reloadFromServer() {
    const t = await fetchText(node.id)
    setText(t)
    textRef.current = t
    savedTextRef.current = t // 서버 최신을 기준선으로 → 변경 없음 상태
    baseStamp.current = null // 다음 저장은 서버 최신 기준(사용자가 방금 확인)
    setConflict(false)
    setDirty(false)
  }

  // 에디터 ↔ 프리뷰 스크롤 동기화(양방향, 비율 기준). 한쪽을 움직이면 반대쪽도 따라온다.
  // 에디터 ↔ 프리뷰 스크롤 동기화. 실제 스크롤 컨테이너는 .editor-pane/.preview-pane.
  useScrollSync(editorPaneRef, previewRef, text !== null)

  function splitDrag(e: React.PointerEvent) {
    e.preventDefault()
    const container = (e.currentTarget as HTMLElement).parentElement!
    const rect = container.getBoundingClientRect()
    // 드래그 중 에디터/프리뷰가 pointermove를 가로채지 못하게 투명 오버레이를 덮는다.
    const overlay = document.createElement('div')
    overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;cursor:col-resize'
    document.body.appendChild(overlay)
    function move(ev: PointerEvent) {
      const pct = ((ev.clientX - rect.left) / rect.width) * 100
      setSplit(Math.min(80, Math.max(20, pct)))
    }
    function up() {
      overlay.remove()
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const status = conflict
    ? '충돌'
    : saving
      ? '저장 중…'
      : savedFlash
        ? '저장됨 · 방금'
        : dirty
          ? '● 저장 안 됨'
          : '저장됨'

  return (
    <div className={`editor-shell${autosave ? ' autosave-on' : ''}`}>
      <ViewerToolbar
        node={node}
        space={space}
        path={path}
        onNavigate={onNavigate}
        fullscreen={fullscreen}
        onToggleFullscreen={onToggleFullscreen}
        onClose={onClose}
        activeToken={activeToken}
        onActiveToken={onActiveToken}
        onLocalUpload={onLocalUpload}
        status={status}
        statusClass={
          [dirty && !saving ? 'dirty' : '', savedFlash ? 'saved' : '']
            .filter(Boolean)
            .join(' ') || undefined
        }
      >
        <label className="autosave-toggle">
          <span>자동저장</span>
          <button
            type="button"
            role="switch"
            aria-checked={autosave}
            className={`switch${autosave ? ' on' : ''}`}
            onClick={toggleAutosave}
            title={autosave ? '자동저장 켜짐' : '자동저장 꺼짐'}
          >
            <span className="switch-knob" />
          </button>
        </label>
        <button
          className="btn-utility"
          onClick={() => doSave()}
          disabled={saving || !dirty || readOnly}
        >
          저장 ⌘S
        </button>
      </ViewerToolbar>

      {readOnly && (
        <div className="lock-banner">
          🔒 <strong>{lock?.holder}</strong>님이 편집 중입니다 — 읽기 전용입니다. 편집이 끝나면 자동으로
          이어받습니다.
        </div>
      )}

      {conflict && (
        <div className="conflict-banner">
          다른 사람이 먼저 수정했습니다. 자동저장이 일시정지됐어요.
          <button className="btn-utility" onClick={reloadFromServer}>
            서버 버전 다시 불러오기
          </button>
          <button className="btn-utility" onClick={() => doSave(true)}>
            내 내용으로 덮어쓰기
          </button>
        </div>
      )}

      {loadError ? (
        <div className="viewer-card-wrap">
          <p className="muted">{loadError}</p>
        </div>
      ) : text === null ? (
        <div className="viewer-card-wrap">
          <p className="muted">불러오는 중…</p>
        </div>
      ) : (
        <div className="editor-split">
          <div className="editor-pane" ref={editorPaneRef} style={{ width: `${split}%` }}>
            <CodeMirror
              value={text}
              height="100%"
              theme={appTheme === 'light' ? EDITOR_LIGHT : EDITOR_DARK}
              extensions={[markdown()]}
              onChange={onChange}
              editable={!readOnly}
              readOnly={readOnly}
              basicSetup={{ lineNumbers: true, foldGutter: false }}
            />
          </div>
          <div className="split-handle" onPointerDown={splitDrag} />
          <div className="preview-pane" ref={previewRef} style={{ width: `${100 - split}%` }}>
            {isMarkdown(node) ? (
              <MarkdownPreview text={text} />
            ) : (
              <pre className="plain-preview">{text}</pre>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
