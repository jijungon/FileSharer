import { useState } from 'react'

// 새 폴더/새 MD 이름 입력용 인라인 모달 — window.prompt 대체.
// (임베드/제한 브라우저에서 prompt()가 막히거나 미지원이어도 안 깨지고, 스타일도 앱과 통일.)
export default function NameModal({
  title,
  initial = '',
  submitLabel = '만들기',
  onSubmit,
  onClose,
}: {
  title: string
  initial?: string
  submitLabel?: string
  onSubmit: (name: string) => void
  onClose: () => void
}) {
  const [value, setValue] = useState(initial)
  function submit() {
    const v = value.trim()
    if (v) onSubmit(v)
  }
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="name-modal" onClick={(e) => e.stopPropagation()}>
        <h3 className="modal-title">{title}</h3>
        <input
          className="modal-input"
          autoFocus
          spellCheck={false}
          value={value}
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              submit()
            } else if (e.key === 'Escape') {
              e.preventDefault()
              onClose()
            }
          }}
        />
        <div className="modal-actions">
          <button className="btn-utility" onClick={onClose}>
            취소
          </button>
          <button className="btn-primary" onClick={submit}>
            {submitLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
