import { markdown } from '@codemirror/lang-markdown'
import CodeMirror from '@uiw/react-codemirror'
import { useEffect, useState } from 'react'
import MarkdownPreview from './MarkdownPreview'

/** '새 MD' 편집 모달. 저장 전까지 파일을 만들지 않고, 저장/취소를 선택한다. */
export default function NewMarkdownModal({
  name,
  onCreate,
  onCancel,
}: {
  name: string
  onCreate: (content: string) => Promise<void>
  onCancel: () => void
}) {
  const title = name.replace(/\.md$/i, '')
  const [text, setText] = useState(`# ${title}\n\n`)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  async function save() {
    if (saving) return
    setSaving(true)
    try {
      await onCreate(text)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div
        className="new-md-modal"
        role="dialog"
        aria-label="새 마크다운 문서"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="new-md-head">
          <span className="new-md-name">{name}</span>
          <div className="new-md-actions">
            <button className="btn-utility" onClick={onCancel} disabled={saving}>
              취소
            </button>
            <button className="btn-primary" onClick={save} disabled={saving}>
              {saving ? '저장 중…' : '저장'}
            </button>
          </div>
        </div>
        <div className="editor-split new-md-body">
          <div className="editor-pane" style={{ width: '50%' }}>
            <CodeMirror
              value={text}
              height="100%"
              autoFocus
              extensions={[markdown()]}
              onChange={setText}
              basicSetup={{ lineNumbers: true, foldGutter: false }}
            />
          </div>
          <div className="preview-pane" style={{ width: '50%' }}>
            <MarkdownPreview text={text} />
          </div>
        </div>
      </div>
    </div>
  )
}
