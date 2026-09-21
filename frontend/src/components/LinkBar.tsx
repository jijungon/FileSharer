import { useState } from 'react'
import ServerUploadPopover from './ServerUploadPopover'
import SharePopover from './SharePopover'
import { SpaceInfo } from '../lib/api'
import { downloadUrl, NodeInfo } from '../lib/files'

interface Props {
  space: SpaceInfo | null
  path: NodeInfo[]
  selected: NodeInfo | null
  onNavigate: (index: number | null) => void // null = 공간 루트
  onDropToCrumb: (draggedId: string, targetIndex: number | null) => void
  activeToken?: string | null // 지금 메모리에 든 임시 토큰 — 서버 업로드 curl 자동 채움
  onActiveToken: (token: string | null) => void // 임시 토큰 발급/해제 반영
  onLocalUpload?: () => void // 내 PC에서 현재 위치로 업로드(파일 선택창 열기)
}

export default function LinkBar({
  space,
  path,
  selected,
  onNavigate,
  onDropToCrumb,
  activeToken,
  onActiveToken,
  onLocalUpload,
}: Props) {
  const [copied, setCopied] = useState(false)
  const [shareOpen, setShareOpen] = useState(false)
  const [serverUpOpen, setServerUpOpen] = useState(false)

  const target = selected ?? (path.length > 0 ? path[path.length - 1] : null)
  // 서버 업로드는 '현재 디렉터리'가 대상 — 선택 파일이 아니라 지금 보고 있는 폴더/공간 루트.
  const currentFolder = path.length > 0 ? path[path.length - 1] : null
  const currentLabel = currentFolder?.name ?? space?.name ?? ''

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
        {/* 로컬: 다운로드 · 로컬 업로드 (연한 노랑) */}
        {target && (
          <a href={downloadUrl(target)}>
            <button className="btn-utility btn-tier-local">다운로드</button>
          </a>
        )}
        {space && onLocalUpload && (
          <button
            className="btn-utility btn-tier-local"
            onClick={onLocalUpload}
            title="내 PC에서 이 위치로 업로드 (폴더는 끌어다 놓기)"
          >
            ↑ 로컬 업로드
          </button>
        )}
        {space && <span className="action-divider" aria-hidden="true" />}
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
        {target && (
          <button className="btn-utility btn-tier-link" onClick={copyInternalLink}>
            {copied ? '복사됨 ✓' : '사내 링크 복사'}
          </button>
        )}
        <button
          className="btn-utility btn-tier-link linkbar-share"
          disabled={!target}
          onClick={() => {
            setShareOpen((v) => !v)
            setServerUpOpen(false)
          }}
        >
          공유 링크
        </button>
        {serverUpOpen && space && (
          <ServerUploadPopover
            folderId={currentFolder?.id ?? null}
            spaceId={space.id}
            label={currentLabel}
            activeToken={activeToken}
            onActiveToken={onActiveToken}
            onClose={() => setServerUpOpen(false)}
          />
        )}
        {shareOpen && target && (
          <SharePopover node={target} onClose={() => setShareOpen(false)} />
        )}
      </div>
    </div>
  )
}
