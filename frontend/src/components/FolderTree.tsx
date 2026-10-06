import { useEffect, useMemo, useRef, useState } from 'react'
import { attachDragChip } from '../lib/dragchip'
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
    // targetName: 되돌리기 띠가 '어디로 옮겼는지' 를 말하려면 이름이 필요하다.
    // 폴더 id 만으로는 부르는 쪽이 그 이름을 알 길이 없다(사이드바 트리의 행이라
    // 메인 목록에 없을 수 있다). 아는 쪽에서 같이 보낸다. 공간 루트면 undefined.
    ctx: { srcSpaceId: string; targetSpaceId: string; targetName?: string },
  ) => void
  onUploadFiles?: (targetFolderId: string | null, e: React.DragEvent) => void // 로컬 파일/폴더 → 그 폴더(null=공간 루트)로 업로드
  // 행에서 바로 하는 것들 — 이름변경(고르고 Enter) · ★ 즐겨찾기 · 🗑 휴지통.
  // 이름변경은 인라인(제자리 입력) — 빈/동일 이름이면 호출 안 함.
  onRenameCommit?: (row: TreeRow, newName: string) => void
  onToggleFavorite?: (row: TreeRow) => void
  onDelete?: (row: TreeRow) => void
  /** 고른 것 중 폴더가 몇 개인지 부모에게 알린다 — 하단 바가 "폴더 N개 포함"을 띄우는 데 쓴다. */
  onFolderCount?: (n: number) => void
  // ── 다중선택 ──
  // 선택 집합은 부모(Files)가 들고 있다. 대량작업과 하단 바가 거기 있고, 공간이 여러 개라
  // 트리도 여러 개인데 선택은 한 공간 안에서만 성립하기 때문이다.
  checked?: Set<string>
  // 다음 선택을 **이전 값으로부터** 계산해 넘긴다. 연달아 빠르게 누르면 props의 checked 는
  // 아직 직전 클릭의 결과를 담고 있지 않아(리렌더 전), 통째로 덮어쓰면 클릭 하나가 먹힌다.
  onChecked?: (ofSpace: string, update: (prev: Set<string>) => Set<string>) => void
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
  onFolderCount,
  checked,
  onChecked,
}: Props) {
  const [rows, setRows] = useState<TreeRow[]>([])
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [dragOverId, setDragOverId] = useState<string | null>(null) // 드래그가 올라온 폴더(드롭 대상 강조)
  const [draggingId, setDraggingId] = useState<string | null>(null) // 지금 끌고 있는 행(흐리게 표시)
  const [hoverRowId, setHoverRowId] = useState<string | null>(null) // 커서가 실제로 올라간 행(약한 표시)
  const [renaming, setRenaming] = useState<string | null>(null) // 인라인 이름변경 중인 노드 id

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
  // 행 하나를 id 로 집어오는 표(키보드가 '이게 폴더인가'를 물어본다).
  // buildTree 안의 byId 는 거기서만 사는 지역 변수라 밖에서 못 쓴다.
  const rowOf = useMemo(() => {
    const m = new Map<string, TreeRow>()
    rows.forEach((r) => m.set(r.id, r))
    return m
  }, [rows])
  const nameOf = useMemo(() => {
    const m = new Map<string, string>()
    rows.forEach((r) => m.set(r.id, r.name))
    return m
  }, [rows])
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

  // ── 키보드 ──
  // **커서를 따로 만들지 않는다.** 행 이름이 이미 <button> 이라 브라우저 포커스가 곧
  // 커서다. 별도 state 로 흉내 내면 화면의 파란 테두리와 실제 포커스가 어긋나고,
  // 스크린리더는 흉내낸 쪽을 아예 못 본다.
  //
  // 대신 **로빙 탭인덱스**(ARIA 트리의 표준): 트리 전체에서 tabIndex=0 인 행은 하나뿐이고
  // 나머지는 -1 이다. Tab 으로 트리에 한 번 들어오고, 그 안은 화살표로 움직인다.
  // 이게 없으면 파일이 200개일 때 Tab 을 200번 눌러야 트리를 빠져나간다.
  const [cursor, setCursor] = useState<string | null>(null)
  const nameRefs = useRef(new Map<string, HTMLButtonElement>())

  function focusRow(id: string | undefined) {
    if (!id) return
    setCursor(id)
    nameRefs.current.get(id)?.focus()
  }

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

  // 접거나 지워서 **커서가 가리키던 행이 화면에서 사라지면** 탭인덱스 0 인 행이 하나도
  // 없어진다 — 그러면 Tab 으로 트리에 들어올 수가 없다. 첫 행으로 되돌린다.
  useEffect(() => {
    if (visibleOrder.length === 0) return
    if (!cursor || !visibleOrder.includes(cursor)) setCursor(visibleOrder[0])
  }, [visibleOrder, cursor])

  // 고른 것 안에 폴더가 몇 개인가. 폴더를 고르면 **그 안의 파일도 함께** 삭제·이동되는데,
  // 개수만 봐서는 그게 안 보인다("6개 선택됨"인데 파일 8개가 사라지는 식). 하단 바가
  // 그 사실을 말해줄 수 있게 세어서 올려보낸다. 접힌 폴더도 세야 하므로 트리를 끝까지 훑는다.
  const selectedFolders = useMemo(() => {
    if (!checked) return 0
    let n = 0
    const walk = (nodes: TreeNode[]) => {
      for (const node of nodes) {
        if (node.type === 'folder' && checked.has(node.id)) n += 1
        walk(node.children)
      }
    }
    walk(tree)
    return n
  }, [tree, checked])

  useEffect(() => {
    if (checked) onFolderCount?.(selectedFolders)
  }, [checked, selectedFolders, onFolderCount])

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
    // 그냥 클릭 = 앞의 선택을 버리고 **이것 하나만** 고른 상태로 만든다.
    // 예전엔 선택을 비우기만 하고 누른 것을 담지 않았다. 그래서 파일 넷을 눌러도
    // (하나는 그냥 + 셋은 Ctrl) 하단 바가 셋이라고 했다 — **처음 누른 것이 늘 빠졌다.**
    // Shift 는 기준점을 범위에 포함하는데 Ctrl 만 빼먹어 두 방식이 어긋나 있었다.
    //
    // 폴더는 담지 않는다. 폴더 클릭은 '펼치고 이동'이라 선택으로 볼 일이 아니고,
    // 선택에 폴더가 섞이면 그 안의 파일까지 딸려가 화면에 없는 것이 지워진다.
    onChecked?.(spaceId, () => (node.type === 'folder' ? new Set() : new Set([node.id])))
    anchorRef.current = node.id
    if (node.type === 'folder') {
      onOpenFolder(node.id)
      toggle(node.id)
    } else {
      onOpenFile(node)
    }
  }

  /** 트리 안에서의 키보드. 행 하나하나가 아니라 **트리 전체**가 듣는다 —
   *  행마다 달면 움직일 때마다 리스너가 갈아끼워져 빠르게 누르면 키가 샌다.
   *
   *  Enter 는 **건드리지 않는다.** 여기선 이름 바꾸기다(Finder 방식, 아래 tree-name 참고).
   *  그래서 여는 건 ⌘↓ 로 둔다 — Finder 와 같은 짝이다.
   */
  function onTreeKeyDown(e: React.KeyboardEvent) {
    const el = e.target as HTMLElement | null
    // 이름을 고쳐 치는 중이면 전부 그쪽 것이다
    if (el && /^(INPUT|TEXTAREA)$/.test(el.tagName)) return

    const id = cursor
    if (!id) return
    const at = visibleOrder.indexOf(id)
    if (at === -1) return
    const node = rowOf.get(id)
    const isFolder = node?.type === 'folder'
    const isOpen = expanded.has(id)

    const extend = (to: number) => {
      const target = visibleOrder[to]
      if (!target) return
      // Shift 로 움직이면 **지나온 줄을 전부** 담는다. 기준점이 없으면 지금 자리부터.
      if (e.shiftKey && onChecked) {
        const from = anchorRef.current ?? id
        const a = visibleOrder.indexOf(from)
        if (a !== -1) {
          onChecked(spaceId, (prev) => {
            const next = new Set(prev)
            for (const x of visibleOrder.slice(Math.min(a, to), Math.max(a, to) + 1)) next.add(x)
            return next
          })
        }
      } else {
        anchorRef.current = target
      }
      focusRow(target)
    }

    // ⌘↓ = 열기. **ArrowDown 보다 먼저 본다** — 아래 case 가 먼저 걸리면 커서만 내려간다.
    if ((e.metaKey || e.ctrlKey) && e.key === 'ArrowDown') {
      e.preventDefault()
      if (isFolder) {
        onOpenFolder(id)
        if (!isOpen) toggle(id)
      } else if (node) {
        onOpenFile(node)
      }
      return
    }

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        extend(Math.min(at + 1, visibleOrder.length - 1))
        break
      case 'ArrowUp':
        e.preventDefault()
        extend(Math.max(at - 1, 0))
        break
      case 'ArrowRight':
        e.preventDefault()
        // 닫힌 폴더면 펼치고, 이미 펼쳤으면 **그 안 첫 줄로** 들어간다(트리의 표준 동작)
        if (isFolder && !isOpen) toggle(id)
        else if (isFolder && isOpen) focusRow(visibleOrder[at + 1])
        break
      case 'ArrowLeft':
        e.preventDefault()
        // 펼친 폴더면 접고, 아니면 **부모로** 올라간다 — 깊이 들어갔을 때 빠져나오는 길
        if (isFolder && isOpen) toggle(id)
        else focusRow(parentOf.get(id) ?? undefined)
        break
      case 'Home':
        e.preventDefault()
        focusRow(visibleOrder[0])
        break
      case 'End':
        e.preventDefault()
        focusRow(visibleOrder[visibleOrder.length - 1])
        break
      case ' ':
        // 집기·놓기. 폴더는 담지 않는다 — 클릭과 같은 규칙이다(폴더를 담으면 화면에
        // 없는 그 안의 파일까지 딸려간다).
        if (!onChecked || isFolder) break
        e.preventDefault()
        onChecked(spaceId, (prev) => {
          const next = new Set(prev)
          if (next.has(id)) next.delete(id)
          else next.add(id)
          return next
        })
        anchorRef.current = id
        break
      default:
        break
    }
  }

  // 인라인 이름변경: 시작(메뉴 닫고 그 자리에 입력창) / 커밋(빈·동일 이름이면 무시)
  function beginRename(node: TreeRow) {
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
          onDropToFolder?.(actual, targetId, {
            srcSpaceId: srcSpace,
            targetSpaceId: spaceId,
            targetName: targetId ? nameOf.get(targetId) : undefined,
          })
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
    // 기본 고스트는 뒤(드롭 위치)를 가리므로 커서 옆 작은 칩으로 대체(#81).
    // 휴지통 표도 같은 칩을 쓴다 — 같은 동작은 같아 보여야 한다(lib/dragchip.ts).
    attachDragChip(e, { count: ids.length, name: node.name, type: node.type })
  }

  function renderNode(node: TreeNode, depth = 0) {
    const isFolder = node.type === 'folder'
    const isOpen = expanded.has(node.id)
    const hasChildren = node.children.length > 0
    const active = isFolder ? node.id === currentFolderId : node.id === selectedFileId
    // li 에 role="none" — tree 가 거느리는 것은 treeitem 이어야 한다. 그냥 두면 li 의
    // 기본 역할(listitem)이 사이에 끼어 보조기술이 트리 구조를 못 읽는다.
    // 실제 treeitem 은 그 안의 div 다(클래스·핸들러가 거기 붙어 있다).
    return (
      <li key={node.id} className="tree-li" role="none">
        <div
          role="treeitem"
          aria-level={depth + 1}
          aria-selected={sel.has(node.id)}
          aria-expanded={isFolder ? isOpen : undefined}
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
              // 로빙 탭인덱스 — 트리에서 Tab 으로 닿는 행은 **하나**뿐이다.
              tabIndex={cursor === node.id ? 0 : -1}
              ref={(el) => {
                if (el) nameRefs.current.set(node.id, el)
                else nameRefs.current.delete(node.id)
              }}
              // 마우스로 눌러 들어와도 커서가 거기 있어야 한다 — 그 다음 화살표가
              // 엉뚱한 데서 출발하면 '방금 누른 줄'과 '움직이는 줄'이 달라진다.
              onFocus={() => setCursor(node.id)}
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
          <ul className="tree-branch" role="group">
            {node.children.map((c) => renderNode(c, depth + 1))}
          </ul>
        )}
      </li>
    )
  }

  return (
    <>
      {tree.length > 0 && (
        <ul
          className="folder-tree tree-branch"
          role="tree"
          aria-label="공간·폴더"
          aria-multiselectable={onChecked ? true : undefined}
          onKeyDown={onTreeKeyDown}
        >
          {tree.map((n) => renderNode(n, 0))}
        </ul>
      )}
    </>
  )
}
