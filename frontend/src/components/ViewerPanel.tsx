import { markdown } from '@codemirror/lang-markdown'
import CodeMirror, { EditorView } from '@uiw/react-codemirror'
import { useScrollSync } from '../lib/scrollsync'
import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError } from '../lib/api'
import { downloadUrl, NodeInfo } from '../lib/files'
import { formatBytes } from '../lib/format'

// DnX풍 다크 에디터 테마 (near-black base + 골드 커서/활성줄)
const EDITOR_DARK = EditorView.theme(
  {
    '&': { color: '#e9e8ec', backgroundColor: '#18181a' },
    '.cm-content': { caretColor: '#c9a454' },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: '#c9a454' },
    '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, .cm-content ::selection': {
      backgroundColor: '#3a3427',
    },
    '.cm-gutters': { backgroundColor: '#18181a', color: '#6b6a72', border: 'none' },
    '.cm-activeLine': { backgroundColor: 'rgba(201, 164, 84, 0.05)' },
    '.cm-activeLineGutter': { backgroundColor: 'rgba(201, 164, 84, 0.06)', color: '#c9a454' },
    '.cm-selectionMatch': { backgroundColor: 'rgba(201, 164, 84, 0.14)' },
  },
  { dark: true },
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

interface Props {
  node: NodeInfo
  fullscreen: boolean
  onToggleFullscreen: () => void
  onNodeUpdated: (fresh: NodeInfo) => void
  onClose: () => void
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

function MediaPreview({ node, onClose, kind, fullscreen, onToggleFullscreen }: Props & { kind: MediaKind }) {
  const raw = `/api/files/${node.id}/raw`
  return (
    <div className="editor-shell">
      <div className="editor-toolbar">
        <span className="editor-name">{node.name}</span>
        <span className="editor-status">{formatBytes(node.size)}</span>
        {kind === 'html' && (
          <span className="editor-status" title="업로드된 HTML은 보안을 위해 스크립트 없이 표시됩니다">
            HTML · 스크립트 미실행
          </span>
        )}
        <span className="toolbar-spacer" />
        <a href={raw} target="_blank" rel="noreferrer">
          <button className="btn-utility">새 탭</button>
        </a>
        <a href={downloadUrl(node)}>
          <button className="btn-utility">다운로드</button>
        </a>
        <button className="btn-utility" onClick={onToggleFullscreen}>
          {fullscreen ? '분할 보기' : '전체화면'}
        </button>
        <button className="btn-utility" onClick={onClose}>
          닫기
        </button>
      </div>
      {kind === 'image' ? (
        <div className="image-preview">
          <img src={raw} alt={node.name} />
        </div>
      ) : kind === 'video' ? (
        <div className="media-preview">
          <video src={raw} controls preload="metadata" />
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
function OfficePreview({ node, onClose, fullscreen, onToggleFullscreen }: Props) {
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
      <div className="editor-toolbar">
        <span className="editor-name">{node.name}</span>
        <span className="editor-status">{formatBytes(node.size)}</span>
        <span className="editor-status">PDF로 변환됨</span>
        <span className="toolbar-spacer" />
        <a href={downloadUrl(node)}>
          <button className="btn-utility">원본 다운로드</button>
        </a>
        <button className="btn-utility" onClick={onToggleFullscreen}>
          {fullscreen ? '분할 보기' : '전체화면'}
        </button>
        <button className="btn-utility" onClick={onClose}>
          닫기
        </button>
      </div>
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

function TextEditor({ node, fullscreen, onToggleFullscreen, onNodeUpdated, onClose }: Props) {
  const [text, setText] = useState<string | null>(null)
  const [loadError, setLoadError] = useState('')
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [savedFlash, setSavedFlash] = useState(false)
  const [conflict, setConflict] = useState(false)
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
  const autosaveTimer = useRef<number | undefined>(undefined)

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
      })
      .catch((e) => setLoadError(e instanceof Error ? e.message : '불러오기 실패'))
  }, [node.id, node.size])

  const doSave = useCallback(
    async (force = false) => {
      if (saving) return
      setSaving(true)
      try {
        const fresh = await saveContent(
          node.id,
          textRef.current,
          force ? null : baseStamp.current,
        )
        baseStamp.current = fresh.updated_at
        setDirty(false)
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
    setDirty(true)
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
      <div className="editor-toolbar">
        <span className="editor-name">{node.name}</span>
        <span
          className={`editor-status${dirty && !saving ? ' dirty' : ''}${
            savedFlash ? ' saved' : ''
          }`}
        >
          {status}
        </span>
        <span className="toolbar-spacer" />
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
        <button className="btn-utility" onClick={() => doSave()} disabled={saving || !dirty}>
          저장 ⌘S
        </button>
        <button className="btn-utility" onClick={onToggleFullscreen}>
          {fullscreen ? '분할 보기' : '전체화면'}
        </button>
        <button className="btn-utility" onClick={onClose}>
          닫기
        </button>
      </div>

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
              theme={EDITOR_DARK}
              extensions={[markdown()]}
              onChange={onChange}
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
