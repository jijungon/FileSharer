import { useState } from 'react'
import { IconDownload, IconLink, IconServer, IconUpload } from './icons'
import ServerTransferPopover from './ServerTransferPopover'
import SharePopover from './SharePopover'
import { SpaceInfo } from '../lib/api'
import { downloadUrl, NodeInfo } from '../lib/files'

interface Props {
  space: SpaceInfo | null
  path: NodeInfo[]
  selected: NodeInfo | null
  onNavigate?: (index: number | null) => void // null = 공간 루트 (경로 표시용, actionsOnly에선 불필요)
  onDropToCrumb?: (draggedId: string, targetIndex: number | null, srcSpaceId: string) => void
  activeToken?: string | null // 지금 메모리에 든 임시 토큰 — 서버 업로드 curl 자동 채움
  onActiveToken: (token: string | null) => void // 임시 토큰 발급/해제 반영
  onLocalUpload?: () => void // 내 PC에서 현재 위치로 업로드(파일 선택창 열기)
  actionsOnly?: boolean // true=경로(크럼) 없이 액션 버튼만 (상단 바에 얹기 위함)
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
  actionsOnly = false,
}: Props) {
  const [shareOpen, setShareOpen] = useState(false)
  const [serverUpOpen, setServerUpOpen] = useState(false)

  const target = selected ?? (path.length > 0 ? path[path.length - 1] : null)
  // 서버 업로드는 '현재 디렉터리'가 대상 — 선택 파일이 아니라 지금 보고 있는 폴더/공간 루트.
  const currentFolder = path.length > 0 ? path[path.length - 1] : null
  const currentLabel = currentFolder?.name ?? space?.name ?? ''

  function crumbDropHandlers(index: number | null) {
    return {
      onDragOver: (e: React.DragEvent) => {
        if (e.dataTransfer.types.includes('application/x-node-id')) e.preventDefault()
      },
      onDrop: (e: React.DragEvent) => {
        const id = e.dataTransfer.getData('application/x-node-id')
        if (id) {
          e.preventDefault()
          const srcSpace = e.dataTransfer.getData('application/x-node-space')
          onDropToCrumb?.(id, index, srcSpace)
        }
      },
    }
  }

  return (
    <div className={`linkbar${actionsOnly ? ' linkbar--actions-only' : ''}`}>
      {!actionsOnly && (
      <div className="linkbar-crumbs">
        <button className="crumb" onClick={() => onNavigate?.(null)} {...crumbDropHandlers(null)}>
          {space?.name ?? '…'}
        </button>
        {path.map((folder, i) => (
          <span key={folder.id}>
            <span className="crumb-sep">/</span>
            <button className="crumb" onClick={() => onNavigate?.(i)} {...crumbDropHandlers(i)}>
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
      )}

      <div className="linkbar-actions">
        {/* 로컬: 다운로드 · 로컬 업로드 (연한 노랑) */}
        {target && (
          <a href={downloadUrl(target)}>
            <button className="btn-utility btn-tier-local" title={`${target.name} 내려받기`}>
              <IconDownload />
              <span className="btn-label">다운로드</span>
            </button>
          </a>
        )}
        {space && onLocalUpload && (
          <button
            className="btn-utility btn-tier-local"
            onClick={onLocalUpload}
            // 어느 폴더로 올라가는지 이름으로 말해준다 — "이 위치"만으로는
            // 파일을 열어 둔 상태에서 어디로 가는지 알 수 없다.
            title={`내 PC에서 ${currentLabel}(으)로 업로드 (폴더는 끌어다 놓기)`}
          >
            <IconUpload />
            <span className="btn-label">로컬 업로드</span>
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
            title={`${currentLabel}에서 서버(헤드리스)로 올리고 내리기 — API 토큰 + curl`}
          >
            <IconServer />
            <span className="btn-label">서버</span>
          </button>
        )}
        {/* 링크: 공유 링크 (진한 노랑). '사내 링크 복사'는 공유 팝오버 안으로 옮겨 바를 정리했다. */}
        <button
          className="btn-utility btn-tier-link linkbar-share"
          disabled={!target}
          onClick={() => {
            setShareOpen((v) => !v)
            setServerUpOpen(false)
          }}
          title={target ? `${target.name} 공유 — 사내 주소 / 사외 링크` : '공유할 파일을 먼저 고르세요'}
        >
          <IconLink />
          <span className="btn-label">공유 링크</span>
        </button>
        {serverUpOpen && space && (
          <ServerTransferPopover
            folderId={currentFolder?.id ?? null}
            spaceId={space.id}
            label={currentLabel}
            // 내려받을 대상 = 선택한 파일, 없으면 지금 보고 있는 폴더(공유 버튼과 같은 기준)
            downloadTarget={
              target ? { id: target.id, name: target.name, type: target.type } : null
            }
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
