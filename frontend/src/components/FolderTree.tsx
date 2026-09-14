import { useEffect, useMemo, useState } from 'react'
import { FolderRow, listSpaceFolders } from '../lib/files'

interface TreeNode extends FolderRow {
  children: TreeNode[]
}

function buildTree(rows: FolderRow[]): TreeNode[] {
  const byId = new Map<string, TreeNode>()
  rows.forEach((r) => byId.set(r.id, { ...r, children: [] }))
  const roots: TreeNode[] = []
  byId.forEach((node) => {
    const parent = node.parent_id ? byId.get(node.parent_id) : null
    if (parent) parent.children.push(node)
    else roots.push(node)
  })
  const sortRec = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => a.name.localeCompare(b.name, 'ko'))
    nodes.forEach((n) => sortRec(n.children))
  }
  sortRec(roots)
  return roots
}

interface Props {
  spaceId: string
  currentFolderId: string | null // null = 공간 루트
  version: number // 구조 변경 시 증가 → 다시 로드
  onOpenFolder: (folderId: string) => void
  onDropToFolder?: (draggedId: string, targetFolderId: string | null) => void
}

export default function FolderTree({
  spaceId,
  currentFolderId,
  version,
  onOpenFolder,
  onDropToFolder,
}: Props) {
  const [rows, setRows] = useState<FolderRow[]>([])
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  useEffect(() => {
    let alive = true
    listSpaceFolders(spaceId)
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
      // 현재 폴더 자신도 펼쳐서 그 안의 하위 폴더가 트리에 보이도록
      next.add(currentFolderId)
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
    if (!onDropToFolder) return {}
    return {
      onDragOver: (e: React.DragEvent) => {
        if (e.dataTransfer.types.includes('application/x-node-id')) e.preventDefault()
      },
      onDrop: (e: React.DragEvent) => {
        const id = e.dataTransfer.getData('application/x-node-id')
        if (id) {
          e.preventDefault()
          onDropToFolder(id, targetId)
        }
      },
    }
  }

  function renderNode(node: TreeNode, depth: number) {
    const isOpen = expanded.has(node.id)
    const hasChildren = node.children.length > 0
    return (
      <div key={node.id}>
        <div
          className={`tree-row${node.id === currentFolderId ? ' active' : ''}`}
          style={{ paddingLeft: 8 + depth * 14 }}
          {...dropHandlers(node.id)}
        >
          <button
            className="tree-caret"
            onClick={() => hasChildren && toggle(node.id)}
            style={{ visibility: hasChildren ? 'visible' : 'hidden' }}
            aria-label={isOpen ? '접기' : '펼치기'}
          >
            {isOpen ? '▾' : '▸'}
          </button>
          <button className="tree-name" onClick={() => onOpenFolder(node.id)} title={node.name}>
            {node.name}
          </button>
        </div>
        {isOpen && node.children.map((c) => renderNode(c, depth + 1))}
      </div>
    )
  }

  if (tree.length === 0) return null

  return (
    <div className="folder-tree">
      {tree.map((n) => renderNode(n, 0))}
    </div>
  )
}
