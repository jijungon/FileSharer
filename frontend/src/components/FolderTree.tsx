import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { listSpaceTree, TreeRow } from '../lib/files'

interface TreeNode extends TreeRow {
  children: TreeNode[]
}

// Sticky Scroll: 스크롤 시 상위 폴더 헤더를 트리 상단에 계단식으로 고정한다.
// 겹치지 않게 depth마다 top을 ROW_H씩 내리므로, .tree-row 높이와 반드시 일치시킨다.
const ROW_H = 24

function buildTree(rows: TreeRow[]): TreeNode[] {
  const byId = new Map<string, TreeNode>()
  rows.forEach((r) => byId.set(r.id, { ...r, children: [] }))
  const roots: TreeNode[] = []
  byId.forEach((node) => {
    const parent = node.parent_id ? byId.get(node.parent_id) : null
    if (parent) parent.children.push(node)
    else roots.push(node)
  })
  // 폴더 먼저, 그다음 파일 — 각 그룹 내 이름순(파일 목록과 동일한 정렬)
  const sortRec = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'folder' ? -1 : 1
      return a.name.localeCompare(b.name, 'ko')
    })
    nodes.forEach((n) => sortRec(n.children))
  }
  sortRec(roots)
  return roots
}

interface Props {
  spaceId: string
  currentFolderId: string | null // null = 공간 루트
  selectedFileId?: string | null // 지금 열려 있는 파일(강조)
  favIds?: Set<string> // 즐겨찾기된 노드 id (컨텍스트 메뉴 라벨용)
  version: number // 구조 변경 시 증가 → 다시 로드
  onOpenFolder: (folderId: string) => void
  onOpenFile: (row: TreeRow) => void
  onDropToFolder?: (draggedId: string, targetFolderId: string | null) => void
  onUploadFiles?: (targetFolderId: string | null, e: React.DragEvent) => void // 로컬 파일/폴더 → 그 폴더(null=공간 루트)로 업로드
  // 우클릭 컨텍스트 메뉴 동작(파일목록 표를 대체 — 이름변경/즐겨찾기/삭제)
  onRename?: (row: TreeRow) => void
  onToggleFavorite?: (row: TreeRow) => void
  onDelete?: (row: TreeRow) => void
}

export default function FolderTree({
  spaceId,
  currentFolderId,
  selectedFileId,
  favIds,
  version,
  onOpenFolder,
  onOpenFile,
  onDropToFolder,
  onUploadFiles,
  onRename,
  onToggleFavorite,
  onDelete,
}: Props) {
  const [rows, setRows] = useState<TreeRow[]>([])
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [dragOverId, setDragOverId] = useState<string | null>(null) // 드래그가 올라온 폴더(드롭 대상 강조)
  // 우클릭 컨텍스트 메뉴: 대상 행 + 화면 좌표
  const [menu, setMenu] = useState<{ row: TreeRow; x: number; y: number } | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null)

  // 메뉴가 뷰포트 밖(특히 화면 하단·우측)으로 넘치면 안쪽으로 당겨 항상 보이게 한다.
  // (커서가 트리 맨 아래 항목이면 기본 위치에선 마지막 '삭제' 항목이 화면 밖으로 나갔다.)
  useLayoutEffect(() => {
    if (!menu) {
      setMenuPos(null)
      return
    }
    const el = menuRef.current
    const w = el?.offsetWidth ?? 180
    const h = el?.offsetHeight ?? 150
    const pad = 8
    setMenuPos({
      left: Math.max(pad, Math.min(menu.x, window.innerWidth - w - pad)),
      top: Math.max(pad, Math.min(menu.y, window.innerHeight - h - pad)),
    })
  }, [menu])

  // 메뉴 바깥 클릭/스크롤/Esc 시 닫기
  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(null)
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setMenu(null)
    window.addEventListener('click', close)
    window.addEventListener('resize', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('resize', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [menu])

  useEffect(() => {
    let alive = true
    listSpaceTree(spaceId)
      .then((r) => alive && setRows(r))
      .catch(() => alive && setRows([]))
    return () => {
      alive = false
    }
  }, [spaceId, version])

  // 현재 폴더까지의 조상은 자동으로 펼쳐 보이게
  const parentOf = useMemo(() => {
    const m = new Map<string, string | null>()
    rows.forEach((r) => m.set(r.id, r.parent_id))
    return m
  }, [rows])

  useEffect(() => {
    if (!currentFolderId) return
    setExpanded((prev) => {
      const next = new Set(prev)
      next.add(currentFolderId) // 현재 폴더 자신도 펼쳐 그 안이 보이도록
      let cur: string | null | undefined = parentOf.get(currentFolderId)
      let hops = 0
      while (cur && hops < 100) {
        next.add(cur)
        cur = parentOf.get(cur)
        hops += 1
      }
      return next
    })
  }, [currentFolderId, parentOf])

  const tree = useMemo(() => buildTree(rows), [rows])

  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function dropHandlers(targetId: string | null) {
    if (!onDropToFolder && !onUploadFiles) return {}
    return {
      onDragOver: (e: React.DragEvent) => {
        const t = e.dataTransfer.types
        // 내부 항목 이동(x-node-id) 또는 로컬 파일 업로드(Files) 둘 다 대상 폴더를 강조한다.
        if (t.includes('application/x-node-id') || t.includes('Files')) {
          e.preventDefault()
          setDragOverId(targetId)
        }
      },
      onDragLeave: () => setDragOverId((cur) => (cur === targetId ? null : cur)),
      onDrop: (e: React.DragEvent) => {
        setDragOverId(null)
        const id = e.dataTransfer.getData('application/x-node-id')
        if (id) {
          e.preventDefault()
          onDropToFolder?.(id, targetId)
        } else if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault()
          onUploadFiles?.(targetId, e) // 로컬 파일/폴더 → 이 폴더(targetId=null이면 공간 루트) 안으로 업로드
        }
      },
    }
  }

  // 트리 항목을 잡아 폴더(이동)·다른 공간(복사)·휴지통(삭제)으로 끌어다 놓을 수 있게 한다.
  // 표를 없앤 뒤 유일한 이동 수단 — 사이드바/공간/휴지통 드롭 핸들러가 읽는 payload를 심는다.
  function rowDragStart(e: React.DragEvent, node: TreeNode) {
    e.dataTransfer.setData('application/x-node-id', node.id)
    e.dataTransfer.setData('application/x-node-ids', JSON.stringify([node.id]))
    e.dataTransfer.effectAllowed = 'copyMove'
    // 기본 고스트는 뒤(드롭 위치)를 가리므로 커서 옆 작은 칩으로 대체(#81)
    if (typeof document !== 'undefined' && e.dataTransfer.setDragImage) {
      const chip = document.createElement('div')
      chip.className = 'drag-chip'
      const icon = document.createElement('span')
      icon.className = 'drag-chip__icon'
      icon.textContent = node.type === 'folder' ? '📁' : '📄'
      const name = document.createElement('span')
      name.className = 'drag-chip__name'
      name.textContent = node.name
      chip.append(icon, name)
      chip.style.position = 'absolute'
      chip.style.top = '-1000px'
      chip.style.left = '-1000px'
      document.body.appendChild(chip)
      try {
        e.dataTransfer.setDragImage(chip, 14, 18)
      } catch {
        /* 미지원 환경 — 기본 고스트로 폴백 */
      }
      setTimeout(() => chip.remove(), 0)
    }
  }

  function renderNode(node: TreeNode, depth = 0) {
    const isFolder = node.type === 'folder'
    const isOpen = expanded.has(node.id)
    const hasChildren = node.children.length > 0
    const active = isFolder ? node.id === currentFolderId : node.id === selectedFileId
    return (
      <li key={node.id} className="tree-li">
        <div
          className={`tree-row${active ? ' active' : ''}${
            dragOverId === node.id ? ' drag-over' : ''
          }${isFolder ? ' tree-row--sticky' : ''}`}
          style={isFolder ? { top: depth * ROW_H, zIndex: 60 - depth } : undefined}
          draggable
          onDragStart={(e) => rowDragStart(e, node)}
          {...dropHandlers(isFolder ? node.id : node.parent_id)}
          onContextMenu={(e) => {
            if (!onRename && !onDelete && !onToggleFavorite) return
            e.preventDefault()
            setMenu({ row: node, x: e.clientX, y: e.clientY })
          }}
        >
          <span className="tree-icon" aria-hidden="true">
            {isFolder ? (isOpen && hasChildren ? '📂' : '📁') : '📄'}
          </span>
          <button
            className="tree-name"
            onClick={() => (isFolder ? (onOpenFolder(node.id), toggle(node.id)) : onOpenFile(node))}
            title={node.name}
          >
            {node.name}
          </button>
          {onToggleFavorite && (
            <button
              className={`tree-fav${favIds?.has(node.id) ? ' on' : ''}`}
              onClick={(e) => {
                e.stopPropagation()
                onToggleFavorite(node)
              }}
              title={favIds?.has(node.id) ? '즐겨찾기 해제' : '즐겨찾기'}
              aria-label={favIds?.has(node.id) ? '즐겨찾기 해제' : '즐겨찾기'}
            >
              {favIds?.has(node.id) ? '★' : '☆'}
            </button>
          )}
        </div>
        {isFolder && isOpen && hasChildren && (
          <ul className="tree-branch">
            {node.children.map((c) => renderNode(c, depth + 1))}
          </ul>
        )}
      </li>
    )
  }

  return (
    <>
      {tree.length > 0 && (
        <ul className="folder-tree tree-branch">{tree.map((n) => renderNode(n, 0))}</ul>
      )}
      {menu && (
        <div
          ref={menuRef}
          className="tree-menu"
          style={{ position: 'fixed', top: menuPos?.top ?? menu.y, left: menuPos?.left ?? menu.x }}
          role="menu"
          onClick={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.preventDefault()}
        >
          <button
            role="menuitem"
            onClick={() => {
              onRename?.(menu.row)
              setMenu(null)
            }}
          >
            ✎ 이름 변경
          </button>
          <button
            role="menuitem"
            onClick={() => {
              onToggleFavorite?.(menu.row)
              setMenu(null)
            }}
          >
            {favIds?.has(menu.row.id) ? '★ 즐겨찾기 해제' : '☆ 즐겨찾기'}
          </button>
          <button
            role="menuitem"
            className="danger"
            onClick={() => {
              onDelete?.(menu.row)
              setMenu(null)
            }}
          >
            🗑 삭제
          </button>
        </div>
      )}
    </>
  )
}
