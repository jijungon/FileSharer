import { useState } from 'react'
import SharePopover from './SharePopover'
import { SpaceInfo } from '../lib/api'
import { downloadUrl, NodeInfo } from '../lib/files'

interface Props {
  space: SpaceInfo | null
  path: NodeInfo[]
  selected: NodeInfo | null
  onNavigate: (index: number | null) => void // null = 공간 루트
  onDropToCrumb: (draggedId: string, targetIndex: number | null) => void
}

export default function LinkBar({ space, path, selected, onNavigate, onDropToCrumb }: Props) {
  const [copied, setCopied] = useState(false)
  const [shareOpen, setShareOpen] = useState(false)

  const target = selected ?? (path.length > 0 ? path[path.length - 1] : null)

  async function copyInternalLink() {
    if (!target) return
    await navigator.clipboard.writeText(`${window.location.origin}/files/${target.id}`)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  function crumbDropHandlers(index: number | null) {
    return {
      onDragOver: (e: React.DragEvent) => {
        if (e.dataTransfer.types.includes('application/x-node-id')) e.preventDefault()
      },
      onDrop: (e: React.DragEvent) => {
        const id = e.dataTransfer.getData('application/x-node-id')
        if (id) {
          e.preventDefault()
          onDropToCrumb(id, index)
        }
      },
    }
  }

  return (
    <div className="linkbar">
      <div className="linkbar-crumbs">
        <button className="crumb" onClick={() => onNavigate(null)} {...crumbDropHandlers(null)}>
          {space?.name ?? '…'}
        </button>
        {path.map((folder, i) => (
          <span key={folder.id}>
            <span className="crumb-sep">/</span>
            <button className="crumb" onClick={() => onNavigate(i)} {...crumbDropHandlers(i)}>
              {folder.name}
            </button>
          </span>
        ))}
        {selected && (
          <>
            <span className="crumb-sep">/</span>
            <span className="crumb-current">{selected.name}</span>
          </>
        )}
      </div>

      <div className="linkbar-actions">
        {target && (
          <>
            <a href={downloadUrl(target)}>
              <button className="btn-utility">다운로드</button>
            </a>
            <button className="btn-utility" onClick={copyInternalLink}>
              {copied ? '복사됨 ✓' : '사내 링크 복사'}
            </button>
          </>
        )}
        <button
          className="btn-primary linkbar-share"
          disabled={!target}
          onClick={() => setShareOpen((v) => !v)}
        >
          공유 링크
        </button>
        {shareOpen && target && (
          <SharePopover node={target} onClose={() => setShareOpen(false)} />
        )}
      </div>
    </div>
  )
}
