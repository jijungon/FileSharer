import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { listSpaceTree, TreeRow } from '../lib/files'

interface TreeNode extends TreeRow {
  children: TreeNode[]
}

// Sticky Scroll: 스크롤 시 상위 폴더 헤더를 트리 상단에 계단식으로 고정한다.
// 겹치지 않게 depth마다 top을 ROW_H씩 내리므로, .tree-row 높이와 반드시 일치시킨다.
const ROW_H = 24

// 선택이 꺼져 있을 때 쓰는 고정 빈 집합 — 렌더마다 new Set()을 만들지 않게.
const NO_SELECTION: ReadonlySet<string> = new Set()

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
  onDropToFolder?: (
    draggedIds: string[], // 다중선택을 끌면 여러 개가 한 번에 온다
    targetFolderId: string | null,
    ctx: { srcSpaceId: string; targetSpaceId: string },
  ) => void
  onUploadFiles?: (targetFolderId: string | null, e: React.DragEvent) => void // 로컬 파일/폴더 → 그 폴더(null=공간 루트)로 업로드
  // 우클릭 컨텍스트 메뉴 동작(파일목록 표를 대체 — 이름변경/즐겨찾기/삭제)
  // 이름변경은 인라인(제자리 입력) — 빈/동일 이름이면 호출 안 함.
  onRenameCommit?: (row: TreeRow, newName: string) => void
  onToggleFavorite?: (row: TreeRow) => void
  onDelete?: (row: TreeRow) => void
  // ── 다중선택 ──
  // 선택 집합은 부모(Files)가 들고 있다. 대량작업과 하단 바가 거기 있고, 공간이 여러 개라
  // 트리도 여러 개인데 선택은 한 공간 안에서만 성립하기 때문이다.
  checked?: Set<string>
  // 다음 선택을 **이전 값으로부터** 계산해 넘긴다. 연달아 빠르게 누르면 props의 checked 는
  // 아직 직전 클릭의 결과를 담고 있지 않아(리렌더 전), 통째로 덮어쓰면 클릭 하나가 먹힌다.
  onChecked?: (ofSpace: string, update: (prev: Set<string>) => Set<string>) => void
  onBulkDelete?: (ids: string[]) => void
  onBulkDownload?: (ids: string[]) => void
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
  onRenameCommit,
  onToggleFavorite,
  onDelete,
  checked,
  onChecked,
  onBulkDelete,
  onBulkDownload,
}: Props) {
  const [rows, setRows] = useState<TreeRow[]>([])
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [dragOverId, setDragOverId] = useState<string | null>(null) // 드래그가 올라온 폴더(드롭 대상 강조)
  const [draggingId, setDraggingId] = useState<string | null>(null) // 지금 끌고 있는 행(흐리게 표시)
  const [hoverRowId, setHoverRowId] = useState<string | null>(null) // 커서가 실제로 올라간 행(약한 표시)
  const [renaming, setRenaming] = useState<string | null>(null) // 인라인 이름변경 중인 노드 id
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

  // ── 다중선택 ──
  // 범위 선택은 **지금 화면에 보이는 순서** 위에서 일어난다. 접힌 폴더 안까지 집어가면
  // "화면에서 두 줄을 골랐는데 서른 개가 지워지는" 일이 생긴다.
  const sel = checked ?? NO_SELECTION
  const anchorRef = useRef<string | null>(null) // Shift 범위의 기준점

  const visibleOrder = useMemo(() => {
    const out: string[] = []
    const walk = (nodes: TreeNode[]) => {
      for (const n of nodes) {
        out.push(n.id)
        if (n.type === 'folder' && expanded.has(n.id)) walk(n.children)
      }
    }
    walk(tree)
    return out
  }, [tree, expanded])

  // 행을 눌렀을 때. Ctrl/Cmd=하나 집기·놓기, Shift=기준점부터 여기까지, 그냥 클릭=선택 풀고 열기.
  function activateRow(e: React.MouseEvent, node: TreeNode) {
    const multi = e.metaKey || e.ctrlKey
    const anchor = anchorRef.current
    if (onChecked && (multi || (e.shiftKey && anchor))) {
      e.preventDefault()
      onChecked(spaceId, (prev) => {
        const next = new Set(prev)
        if (multi) {
          if (next.has(node.id)) next.delete(node.id)
          else next.add(node.id)
        } else if (anchor) {
          const a = visibleOrder.indexOf(anchor)
          const b = visibleOrder.indexOf(node.id)
          if (a !== -1 && b !== -1) {
            for (const id of visibleOrder.slice(Math.min(a, b), Math.max(a, b) + 1)) next.add(id)
          }
        }
        return next
      })
      if (multi) anchorRef.current = node.id
      return
    }
    if (sel.size > 0) onChecked?.(spaceId, () => new Set())
    anchorRef.current = node.id
    if (node.type === 'folder') {
      onOpenFolder(node.id)
      toggle(node.id)
    } else {
      onOpenFile(node)
    }
  }

  // 인라인 이름변경: 시작(메뉴 닫고 그 자리에 입력창) / 커밋(빈·동일 이름이면 무시)
  function beginRename(node: TreeRow) {
    setMenu(null)
    setRenaming(node.id)
  }
  function commitRename(node: TreeRow, raw: string) {
    setRenaming(null)
    const name = raw.trim()
    if (name && name !== node.name) onRenameCommit?.(node, name)
  }

  // targetId = 실제로 놓이는 곳(파일 위에 놓으면 그 파일의 '부모 폴더'), rowId = 커서가 올라간 행.
  // 파일 위에서는 둘이 달라진다 — 그때 대상 폴더만 강조하면 강조가 커서를 안 따라오는 것처럼
  // 보이므로, 커서가 올라간 행에도 약한 표시를 줘서 "여기 놓으면 저 폴더로 간다"가 같이 읽히게 한다.
  function dropHandlers(targetId: string | null, rowId: string | null) {
    if (!onDropToFolder && !onUploadFiles) return {}
    return {
      onDragOver: (e: React.DragEvent) => {
        const t = e.dataTransfer.types
        // 내부 항목 이동(x-node-id) 또는 로컬 파일 업로드(Files) 둘 다 대상 폴더를 강조한다.
        if (t.includes('application/x-node-id') || t.includes('Files')) {
          e.preventDefault()
          setDragOverId(targetId)
          setHoverRowId(rowId)
        }
      },
      onDragLeave: () => {
        setDragOverId((cur) => (cur === targetId ? null : cur))
        setHoverRowId((cur) => (cur === rowId ? null : cur))
      },
      onDrop: (e: React.DragEvent) => {
        setDragOverId(null)
        setHoverRowId(null)
        const id = e.dataTransfer.getData('application/x-node-id')
        if (id) {
          e.preventDefault()
          // 다중선택을 끌었으면 x-node-ids 에 전부 들어 있다(없거나 깨졌으면 끌던 한 개로).
          let ids = [id]
          const many = e.dataTransfer.getData('application/x-node-ids')
          if (many) {
            try {
              const parsed = JSON.parse(many) as string[]
              if (Array.isArray(parsed) && parsed.length > 0) ids = parsed
            } catch {
              /* 단일로 폴백 */
            }
          }
          // 소스 공간을 함께 넘겨, 드롭 지점에서 같은 공간이면 이동·다른 공간이면 복사로 판단하게 한다.
          const srcSpace = e.dataTransfer.getData('application/x-node-space')
          // 같은 공간 안에서 **이미 그 폴더에 있는** 항목은 빼고 넘긴다. 파일 위에 놓으면
          // 대상이 그 파일의 부모 폴더라, 형제 위에 놓는 건 제자리 이동이다 — 보내봐야
          // 달라지는 것 없이 수정시각·수정자만 갱신된다.
          const moving = srcSpace === spaceId
          const actual = moving ? ids.filter((n) => parentOf.get(n) !== targetId) : ids
          if (actual.length === 0) return
          onDropToFolder?.(actual, targetId, { srcSpaceId: srcSpace, targetSpaceId: spaceId })
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
    // 고른 것 중 하나를 끌면 고른 것 전부가 따라간다(Finder식). 그 외에는 이 행 하나만.
    const ids = sel.has(node.id) && sel.size > 1 ? [...sel] : [node.id]
    e.dataTransfer.setData('application/x-node-id', node.id)
    e.dataTransfer.setData('application/x-node-ids', JSON.stringify(ids))
    e.dataTransfer.setData('application/x-node-space', spaceId) // 소스 공간 — 드롭 시 이동/복사 판단 기준

    e.dataTransfer.effectAllowed = 'copyMove'
    // 기본 고스트는 뒤(드롭 위치)를 가리므로 커서 옆 작은 칩으로 대체(#81)
    if (typeof document !== 'undefined' && e.dataTransfer.setDragImage) {
      const chip = document.createElement('div')
      chip.className = 'drag-chip'
      const icon = document.createElement('span')
      icon.className = 'drag-chip__icon'
      icon.textContent = ids.length > 1 ? '🗂' : node.type === 'folder' ? '📁' : '📄'
      const name = document.createElement('span')
      name.className = 'drag-chip__name'
      name.textContent = ids.length > 1 ? `${ids.length}개 항목` : node.name
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
          }${
            // 커서가 올라간 행이 실제 대상과 다를 때만(=파일 위) 약한 표시를 덧붙인다
            hoverRowId === node.id && dragOverId !== node.id ? ' drag-hover' : ''
          }${draggingId === node.id ? ' dragging' : ''}${
            isFolder ? ' tree-row--sticky' : ''
          }${sel.has(node.id) ? ' checked' : ''}`}
          style={isFolder ? { top: depth * ROW_H, zIndex: 60 - depth } : undefined}
          draggable={renaming !== node.id}
          onDragStart={(e) => {
            setDraggingId(node.id)
            rowDragStart(e, node)
          }}
          onDragEnd={() => {
            setDraggingId(null)
            setDragOverId(null) // 드롭 밖에서 놓아도 강조가 남지 않게
            setHoverRowId(null)
          }}
          {...dropHandlers(isFolder ? node.id : node.parent_id, node.id)}
          onContextMenu={(e) => {
            if (!onRenameCommit && !onDelete && !onToggleFavorite) return
            e.preventDefault()
            setMenu({ row: node, x: e.clientX, y: e.clientY })
          }}
        >
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
          <span className="tree-icon" aria-hidden="true">
            {isFolder ? (isOpen && hasChildren ? '📂' : '📁') : '📄'}
          </span>
          {renaming === node.id ? (
            <input
              className="tree-rename-input"
              defaultValue={node.name}
              autoFocus
              spellCheck={false}
              onFocus={(e) => e.currentTarget.select()}
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  commitRename(node, e.currentTarget.value)
                } else if (e.key === 'Escape') {
                  e.preventDefault()
                  setRenaming(null)
                }
              }}
              onBlur={(e) => commitRename(node, e.currentTarget.value)}
            />
          ) : (
            <button
              className="tree-name"
              onClick={(e) => activateRow(e, node)}
              // Shift+클릭은 브라우저 기본 동작이 '텍스트 범위 선택'이라, 막지 않으면
              // 범위를 고를 때마다 파일 이름들이 파랗게 드래그된 것처럼 보인다.
              onMouseDown={(e) => e.shiftKey && e.preventDefault()}
              onKeyDown={(e) => {
                // 선택 후 Enter → 인라인 이름변경(Finder식). 기본 Enter=열기를 막는다.
                if (e.key === 'Enter' && onRenameCommit) {
                  e.preventDefault()
                  beginRename(node)
                }
              }}
              title={node.name}
            >
              {node.name}
            </button>
          )}
          {onDelete && (
            <button
              className="tree-trash"
              onClick={(e) => {
                e.stopPropagation()
                onDelete(node)
              }}
              title="휴지통으로 이동"
              aria-label="휴지통으로 이동"
            >
              🗑
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
          {/* 고른 것 위에서 우클릭하면 고른 것 전부에 대한 메뉴로 바뀐다.
              (이름 변경·즐겨찾기는 하나짜리 동작이라 여기 없다. 이동·복사는 드래그로.) */}
          {sel.size > 1 && sel.has(menu.row.id) ? (
            <>
              <button
                role="menuitem"
                onClick={() => {
                  onBulkDownload?.([...sel])
                  setMenu(null)
                }}
              >
                ⤓ {sel.size}개 내려받기
              </button>
              <button
                role="menuitem"
                onClick={() => {
                  onChecked?.(spaceId, () => new Set())
                  setMenu(null)
                }}
              >
                ✕ 선택 해제
              </button>
              <button
                role="menuitem"
                className="danger"
                onClick={() => {
                  onBulkDelete?.([...sel])
                  setMenu(null)
                }}
              >
                🗑 {sel.size}개 삭제
              </button>
            </>
          ) : (
            <>
              <button role="menuitem" onClick={() => beginRename(menu.row)}>
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
            </>
          )}
        </div>
      )}
    </>
  )
}
