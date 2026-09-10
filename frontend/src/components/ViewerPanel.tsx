import { markdown } from '@codemirror/lang-markdown'
import CodeMirror from '@uiw/react-codemirror'
import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError } from '../lib/api'
import { downloadUrl, NodeInfo } from '../lib/files'
import { formatBytes } from '../lib/format'
import { fetchText, isMarkdown, isTextFile, saveContent } from '../lib/markdown'
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
  if (isTextFile(props.node)) return <TextEditor {...props} key={props.node.id} />
  return <DownloadCard {...props} />
}

function DownloadCard({ node, onClose }: Props) {
  return (
    <div className="viewer-card-wrap">
      <div className="viewer-card">
        <div className="viewer-card-icon">📄</div>
        <div>
          <div className="viewer-card-name">{node.name}</div>
          <div className="muted">
            {formatBytes(node.size)} · 미리보기를 지원하지 않는 형식입니다
          </div>
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

  function splitDrag(e: React.PointerEvent) {
    e.preventDefault()
    const container = (e.currentTarget as HTMLElement).parentElement!
    const rect = container.getBoundingClientRect()
    function move(ev: PointerEvent) {
      const pct = ((ev.clientX - rect.left) / rect.width) * 100
      setSplit(Math.min(80, Math.max(20, pct)))
    }
    function up() {
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
    <div className="editor-shell">
      <div className="editor-toolbar">
        <span className="editor-name">{node.name}</span>
        <span className={`editor-status${dirty && !saving ? ' dirty' : ''}`}>{status}</span>
        <span className="toolbar-spacer" />
        <label className="autosave-toggle">
          <input type="checkbox" checked={autosave} onChange={toggleAutosave} /> 자동저장
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
          <div className="editor-pane" style={{ width: `${split}%` }}>
            <CodeMirror
              value={text}
              height="100%"
              extensions={[markdown()]}
              onChange={onChange}
              basicSetup={{ lineNumbers: true, foldGutter: false }}
            />
          </div>
          <div className="split-handle" onPointerDown={splitDrag} />
          <div className="preview-pane" style={{ width: `${100 - split}%` }}>
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
