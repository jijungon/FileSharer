import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import FolderTree from '../components/FolderTree'
import LinkBar from '../components/LinkBar'
import ViewerPanel from '../components/ViewerPanel'
import { api, ApiError, Me, SpaceInfo } from '../lib/api'
import { downloadUrlData, supportsDragOut } from '../lib/dragout'
import { formatBytes, formatDateTime } from '../lib/format'
import { partitionBySize } from '../lib/upload'
import {
  createFolder,
  deleteNode,
  downloadUrl,
  getNodePath,
  listNodeChildren,
  listSpaceChildren,
  listTrash,
  copyNode,
  moveNode,
  NodeInfo,
  renameNode,
  restoreNode,
  uploadFile,
} from '../lib/files'

type SortKey = 'name' | 'size' | 'created' | 'updated'
type SortDir = 'asc' | 'desc'

function compareNodes(a: NodeInfo, b: NodeInfo, key: SortKey, dir: SortDir): number {
  // 폴더는 항상 먼저 (그룹 고정) — 정렬 방향과 무관
  if (a.type !== b.type) return a.type === 'folder' ? -1 : 1
  let cmp = 0
  if (key === 'size') cmp = a.size - b.size
  else if (key === 'created') cmp = (a.created_at ?? '').localeCompare(b.created_at ?? '')
  else if (key === 'updated') cmp = (a.updated_at ?? '').localeCompare(b.updated_at ?? '')
  if (cmp === 0) cmp = a.name.localeCompare(b.name, 'ko') // 이름 정렬 + 동점 tie-break
  return dir === 'asc' ? cmp : -cmp
}

export default function Files() {
  const navigate = useNavigate()
  const { nodeId } = useParams()
  const [me, setMe] = useState<Me | null>(null)
  const [spaces, setSpaces] = useState<SpaceInfo[]>([])
  const [spaceId, setSpaceId] = useState<string | null>(null)
  const [path, setPath] = useState<NodeInfo[]>([])
  const [items, setItems] = useState<NodeInfo[]>([])
  const [selected, setSelected] = useState<NodeInfo | null>(null)
  const [trashMode, setTrashMode] = useState(false)
  const [notice, setNotice] = useState('')
  const [maxUploadMb, setMaxUploadMb] = useState(0)
  const [dropActive, setDropActive] = useState(false)
  const [fullscreen, setFullscreen] = useState(false)
  const [bootError, setBootError] = useState('')
  const [viewerH, setViewerH] = useState(340)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingName, setEditingName] = useState('')
  const [sortKey, setSortKey] = useState<SortKey>('name')
  const [sortDir, setSortDir] = useState<SortDir>('asc')
  const [dragOverSpace, setDragOverSpace] = useState<string | null>(null)
  const [treeVersion, setTreeVersion] = useState(0)
  const fileInput = useRef<HTMLInputElement>(null)
  const folderInput = useRef<HTMLInputElement | null>(null)
  const restoredFromUrl = useRef(false)
  const navSynced = useRef(false) // 부팅 완료 후 브라우저 뒤로/앞으로(URL) 동기화 활성화

  const space = spaces.find((s) => s.id === spaceId) ?? null
  const currentFolder = path.length > 0 ? path[path.length - 1] : null

  const sortedItems = useMemo(
    () => [...items].sort((a, b) => compareNodes(a, b, sortKey, sortDir)),
    [items, sortKey, sortDir],
  )

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      setSortDir(key === 'name' ? 'asc' : 'desc') // 날짜·크기는 최신·큰 것부터가 자연스러움
    }
  }

  // 초기 로드: me + spaces (+ 딥링크 복원)
  useEffect(() => {
    async function boot() {
      try {
        const [meRes, spacesRes, cfg] = await Promise.all([
          api<Me>('/api/me'),
          api<SpaceInfo[]>('/api/spaces'),
          api<{ max_upload_mb: number }>('/api/auth/config'),
        ])
        setMe(meRes)
        setSpaces(spacesRes)
        setMaxUploadMb(cfg.max_upload_mb)
        if (nodeId && !restoredFromUrl.current) {
          restoredFromUrl.current = true
          try {
            const found = await getNodePath(nodeId)
            setSpaceId(found.space_id)
            if (found.node.type === 'folder') {
              setPath([...found.ancestors, found.node])
              setSelected(null)
            } else {
              setPath(found.ancestors)
              setSelected(found.node)
            }
            navSynced.current = true
            return
          } catch {
            setNotice('링크의 항목을 찾을 수 없습니다')
          }
        }
        setSpaceId((prev) => prev ?? spacesRes[0]?.id ?? null)
        navSynced.current = true
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          navigate('/login', { replace: true })
        } else {
          setBootError(
            '백엔드 API에 연결할 수 없습니다. 개발 모드라면 make dev가 떠 있는지(API: 8642), ' +
              '배포 모드라면 앱 컨테이너 상태를 확인하세요.',
          )
        }
      }
    }
    boot()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 브라우저 뒤로/앞으로: URL(nodeId)이 화면 상태와 어긋나면 URL을 기준으로 복원.
  // 앞으로 이동(폴더 열기 등)은 상태를 먼저 세팅하므로 currentId === nodeId라 건너뛴다.
  useEffect(() => {
    if (!navSynced.current) return
    const currentId = selected?.id ?? currentFolder?.id ?? null
    if ((nodeId ?? null) === currentId) return
    setFullscreen(false)
    setTrashMode(false)
    if (!nodeId) {
      setPath([])
      setSelected(null)
      return
    }
    let alive = true
    getNodePath(nodeId)
      .then((found) => {
        if (!alive) return
        setSpaceId(found.space_id)
        if (found.node.type === 'folder') {
          setPath([...found.ancestors, found.node])
          setSelected(null)
        } else {
          setPath(found.ancestors)
          setSelected(found.node)
        }
      })
      .catch(() => setNotice('항목을 찾을 수 없습니다'))
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeId])

  const reload = useCallback(async () => {
    if (!spaceId) return
    try {
      const list = trashMode
        ? await listTrash(spaceId)
        : currentFolder
          ? await listNodeChildren(currentFolder.id)
          : await listSpaceChildren(spaceId)
      setItems(list)
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) navigate('/login', { replace: true })
      else setNotice(err instanceof Error ? err.message : '목록을 불러오지 못했습니다')
    }
  }, [spaceId, currentFolder, trashMode, navigate])

  useEffect(() => {
    reload()
  }, [reload])

  function flash(msg: string) {
    setNotice(msg)
    setTimeout(() => setNotice(''), 2500)
  }

  function switchSpace(id: string) {
    setSpaceId(id)
    setPath([])
    setSelected(null)
    setFullscreen(false)
    setTrashMode(false)
    navigate('/files')
  }

  function openFolder(folder: NodeInfo) {
    setPath((p) => [...p, folder])
    setSelected(null)
    navigate(`/files/${folder.id}`)
  }

  function selectNode(node: NodeInfo) {
    setSelected(node)
    navigate(`/files/${node.id}`)
  }

  function crumbNavigate(index: number | null) {
    setSelected(null)
    setFullscreen(false)
    if (index === null) {
      setPath([])
      navigate('/files')
    } else {
      const target = path[index]
      setPath(path.slice(0, index + 1))
      navigate(`/files/${target.id}`)
    }
  }

  // 파일 목록에서 상위 폴더로 (path 마지막 바로 앞; 없으면 공간 루트)
  function goUp() {
    crumbNavigate(path.length <= 1 ? null : path.length - 2)
  }

  async function guard<T>(action: () => Promise<T>): Promise<T | undefined> {
    try {
      return await action()
    } catch (err) {
      flash(err instanceof Error ? err.message : '요청에 실패했습니다')
    } finally {
      reload()
      setTreeVersion((v) => v + 1) // 폴더 구조 변경 반영 → 사이드바 트리 갱신
    }
  }

  async function openFolderById(id: string) {
    try {
      const found = await getNodePath(id)
      setSelected(null)
      setFullscreen(false)
      setTrashMode(false)
      setPath(found.node.type === 'folder' ? [...found.ancestors, found.node] : found.ancestors)
      navigate(`/files/${id}`)
    } catch {
      flash('폴더를 열 수 없습니다')
    }
  }

  async function onNewFolder() {
    const name = window.prompt('새 폴더 이름')
    if (!name || !spaceId) return
    await guard(() => createFolder(spaceId, currentFolder?.id ?? null, name))
  }

  async function onNewMd() {
    const raw = window.prompt('새 MD 문서 이름', '새 문서.md')
    if (!raw || !spaceId) return
    const name = raw.endsWith('.md') ? raw : `${raw}.md`
    const title = name.replace(/\.md$/, '')
    const file = new File([`# ${title}\n\n`], name, { type: 'text/markdown' })
    const created = await guard(() =>
      uploadFile({ spaceId, parentId: currentFolder?.id ?? null }, file),
    )
    if (created) selectNode(created)
  }

  async function uploadAll(files: FileList | File[]) {
    if (!spaceId) return
    const { ok, tooBig } = partitionBySize(Array.from(files), maxUploadMb, (f) => f.size)
    for (const file of ok) {
      // 폴더 선택 업로드면 webkitRelativePath에 'folder/sub/file' 경로가 담긴다
      const relPath = file.webkitRelativePath || undefined
      await guard(() => uploadFile({ spaceId, parentId: currentFolder?.id ?? null }, file, relPath))
    }
    if (tooBig.length)
      flash(`${maxUploadMb}MB 초과로 제외됨: ${tooBig.map((f) => f.name).join(', ')}`)
    else if (ok.length) flash('업로드 완료')
  }

  // 드롭된 폴더를 하위까지 재귀로 읽어 상대경로와 함께 업로드
  async function readAllEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
    const out: FileSystemEntry[] = []
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((res, rej) =>
        reader.readEntries(res, rej),
      )
      if (batch.length === 0) break
      out.push(...batch)
    }
    return out
  }

  async function walkEntry(
    entry: FileSystemEntry,
    prefix: string,
    out: { file: File; relPath: string }[],
  ) {
    if (entry.isFile) {
      const file = await new Promise<File>((res, rej) =>
        (entry as FileSystemFileEntry).file(res, rej),
      )
      out.push({ file, relPath: prefix + entry.name })
    } else if (entry.isDirectory) {
      const entries = await readAllEntries((entry as FileSystemDirectoryEntry).createReader())
      for (const child of entries) await walkEntry(child, `${prefix}${entry.name}/`, out)
    }
  }

  async function uploadDropped(entries: FileSystemEntry[]) {
    if (!spaceId) return
    const collected: { file: File; relPath: string }[] = []
    for (const entry of entries) await walkEntry(entry, '', collected)
    const { ok, tooBig } = partitionBySize(collected, maxUploadMb, (c) => c.file.size)
    for (const { file, relPath } of ok) {
      await guard(() => uploadFile({ spaceId, parentId: currentFolder?.id ?? null }, file, relPath))
    }
    if (tooBig.length)
      flash(`${maxUploadMb}MB 초과로 제외됨: ${tooBig.map((c) => c.file.name).join(', ')}`)
    else if (ok.length) flash('업로드 완료')
  }

  function startRename(node: NodeInfo) {
    setEditingId(node.id)
    setEditingName(node.name)
  }

  function cancelRename() {
    setEditingId(null)
    setEditingName('')
  }

  async function commitRename(node: NodeInfo) {
    const name = editingName.trim()
    setEditingId(null)
    if (!name || name === node.name) return
    await guard(() => renameNode(node.id, name))
  }

  async function onDelete(node: NodeInfo) {
    if (!window.confirm(`"${node.name}"을(를) 휴지통으로 이동할까요?`)) return
    await guard(() => deleteNode(node.id))
    if (selected?.id === node.id) setSelected(null)
  }

  async function onMove(draggedId: string, targetFolderId: string | null) {
    if (!spaceId || draggedId === targetFolderId) return
    await guard(() =>
      moveNode(draggedId, targetFolderId ? { parentId: targetFolderId } : { spaceId }),
    )
  }

  async function copyToSpace(draggedId: string, targetSpaceId: string, spaceName: string) {
    if (draggedId === targetSpaceId || targetSpaceId === spaceId) return
    // 공간 간 전송은 복사 — 원본은 그대로 두고 대상 공간에 복사본을 만든다.
    const ok = await guard(() => copyNode(draggedId, { spaceId: targetSpaceId }))
    if (ok) flash(`${spaceName}(으)로 복사했습니다`)
  }

  function viewerDrag(e: React.PointerEvent) {
    e.preventDefault()
    const startY = e.clientY
    const startH = viewerH
    // 드래그 중 아래쪽 iframe(PDF·HTML·오피스)이 pointermove를 가로채면 드래그가 멈춘다.
    // 전체화면 투명 오버레이로 덮어 이벤트를 부모 문서에서 계속 받게 한다.
    // (아래로 빠르게 끌 때 뷰어가 안 따라오던 버그 수정)
    const overlay = document.createElement('div')
    overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;cursor:row-resize'
    document.body.appendChild(overlay)
    function move(ev: PointerEvent) {
      setViewerH(Math.min(window.innerHeight * 0.75, Math.max(180, startH + (startY - ev.clientY))))
    }
    function up() {
      overlay.remove()
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  function rowDragStart(e: React.DragEvent, node: NodeInfo) {
    e.dataTransfer.setData('application/x-node-id', node.id)
    if (supportsDragOut()) {
      e.dataTransfer.setData('DownloadURL', downloadUrlData(node, window.location.origin))
    }
    e.dataTransfer.effectAllowed = 'copyMove'
  }

  if (bootError)
    return (
      <div className="login-page">
        <div className="login-card">
          <h1>⚠️</h1>
          <p>{bootError}</p>
          <button className="btn-primary" onClick={() => window.location.reload()}>
            다시 시도
          </button>
        </div>
      </div>
    )

  if (!me) return null

  return (
    <div className="shell">
      <header className="topbar">
        <h2 className="logo">FileSharer</h2>
        <div className="topbar-right">
          <span className="muted">{me.email}</span>
          {me.role === 'admin' && (
            <Link to="/admin">
              <button className="btn-utility">관리</button>
            </Link>
          )}
          <button
            className="btn-utility"
            onClick={() =>
              api('/api/auth/logout', { method: 'POST' }).then(() => navigate('/login'))
            }
          >
            로그아웃
          </button>
        </div>
      </header>

      <LinkBar
        space={space}
        path={path}
        selected={selected}
        onNavigate={crumbNavigate}
        onDropToCrumb={(id, idx) => onMove(id, idx === null ? null : path[idx].id)}
      />

      <div className="workspace" style={{ display: fullscreen && selected ? 'none' : undefined }}>
        <aside className="sidebar">
          {spaces.map((s) => (
            <div key={s.id}>
              <button
                className={
                  `space-item space-root${s.id === spaceId ? ' active' : ''}` +
                  (dragOverSpace === s.id ? ' drag-over' : '')
                }
                onClick={() => switchSpace(s.id)}
                onDragOver={(e) => {
                  if (e.dataTransfer.types.includes('application/x-node-id')) {
                    e.preventDefault()
                    setDragOverSpace(s.id)
                  }
                }}
                onDragLeave={() => setDragOverSpace((cur) => (cur === s.id ? null : cur))}
                onDrop={(e) => {
                  const id = e.dataTransfer.getData('application/x-node-id')
                  setDragOverSpace(null)
                  if (!id) return
                  e.preventDefault()
                  // 활성 공간 위에 놓으면 그 공간 최상위로 이동, 다른 공간이면 복사
                  if (s.id === spaceId) onMove(id, null)
                  else copyToSpace(id, s.id, s.name)
                }}
                title={
                  s.id === spaceId
                    ? '여기로 놓으면 이 공간 최상위로 이동'
                    : `여기로 항목을 끌어다 놓으면 ${s.name}(으)로 복사`
                }
              >
                {s.name}
              </button>
              {s.id === spaceId && !trashMode && (
                <FolderTree
                  spaceId={s.id}
                  currentFolderId={currentFolder?.id ?? null}
                  version={treeVersion}
                  onOpenFolder={openFolderById}
                  onDropToFolder={(id, target) => onMove(id, target)}
                />
              )}
            </div>
          ))}
          <div className="sidebar-foot">
            <button
              className={`space-item${trashMode ? ' active' : ''}`}
              onClick={() => {
                setTrashMode((t) => !t)
                setSelected(null)
              }}
            >
              휴지통
            </button>
          </div>
        </aside>

        <main
          className={`browser${dropActive ? ' drop-active' : ''}`}
          onDragOver={(e) => {
            if (e.dataTransfer.types.includes('Files')) {
              e.preventDefault()
              setDropActive(true)
            }
          }}
          onDragLeave={() => setDropActive(false)}
          onDrop={(e) => {
            // 폴더 드롭 지원: items에서 동기적으로 entry를 먼저 확보(핸들러 종료 후 무효화됨)
            const entries = e.dataTransfer.items
              ? Array.from(e.dataTransfer.items)
                  .map((it) => it.webkitGetAsEntry?.() ?? null)
                  .filter((x): x is FileSystemEntry => x !== null)
              : []
            if (entries.length > 0) {
              e.preventDefault()
              setDropActive(false)
              uploadDropped(entries)
            } else if (e.dataTransfer.files.length > 0) {
              e.preventDefault()
              setDropActive(false)
              uploadAll(e.dataTransfer.files)
            }
          }}
        >
          <div className="toolbar">
            {!trashMode && (
              <>
                <button className="btn-utility" onClick={onNewFolder}>
                  ＋ 새 폴더
                </button>
                <button className="btn-utility" onClick={() => fileInput.current?.click()}>
                  ↑ 업로드
                </button>
                <button className="btn-utility" onClick={() => folderInput.current?.click()}>
                  ↑ 폴더 업로드
                </button>
                <button className="btn-utility" onClick={onNewMd}>
                  ✎ 새 MD
                </button>
                <input
                  ref={fileInput}
                  type="file"
                  multiple
                  hidden
                  onChange={(e) => {
                    if (e.target.files) uploadAll(e.target.files)
                    e.target.value = ''
                  }}
                />
                <input
                  ref={(el) => {
                    folderInput.current = el
                    // webkitdirectory는 React 타입에 없어 마운트 시 직접 세팅 → 폴더 선택창
                    if (el) {
                      el.setAttribute('webkitdirectory', '')
                      el.setAttribute('directory', '')
                    }
                  }}
                  type="file"
                  multiple
                  hidden
                  onChange={(e) => {
                    if (e.target.files) uploadAll(e.target.files)
                    e.target.value = ''
                  }}
                />
              </>
            )}
            {trashMode && <span className="muted">휴지통 — 복원하면 원래 위치로 돌아갑니다</span>}
            <span className="toolbar-notice">{notice}</span>
          </div>

          <table className="file-table">
            <thead>
              <tr>
                <SortTh label="이름" col="name" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                <SortTh
                  label="올린 날짜"
                  col="created"
                  cls="col-date"
                  sortKey={sortKey}
                  sortDir={sortDir}
                  onSort={toggleSort}
                />
                <SortTh
                  label="수정한 날짜"
                  col="updated"
                  cls="col-date"
                  sortKey={sortKey}
                  sortDir={sortDir}
                  onSort={toggleSort}
                />
                <SortTh
                  label="크기"
                  col="size"
                  cls="col-size"
                  sortKey={sortKey}
                  sortDir={sortDir}
                  onSort={toggleSort}
                />
                <th className="col-actions"></th>
              </tr>
            </thead>
            <tbody>
              {!trashMode && currentFolder && (
                <tr
                  className="row-up"
                  onClick={goUp}
                  title="상위 폴더로"
                  onDragOver={(e) => {
                    if (e.dataTransfer.types.includes('application/x-node-id')) e.preventDefault()
                  }}
                  onDrop={(e) => {
                    const id = e.dataTransfer.getData('application/x-node-id')
                    if (id) {
                      e.preventDefault()
                      onMove(id, currentFolder.parent_id ?? null)
                    }
                  }}
                >
                  <td>
                    <span className="node-icon">↑</span> <span className="node-name">상위 폴더</span>
                  </td>
                  <td className="col-date"></td>
                  <td className="col-date"></td>
                  <td className="col-size"></td>
                  <td className="col-actions"></td>
                </tr>
              )}
              {sortedItems.map((node) => (
                <tr
                  key={node.id}
                  className={selected?.id === node.id ? 'row-selected' : ''}
                  draggable={!trashMode}
                  onDragStart={(e) => rowDragStart(e, node)}
                  onDragOver={(e) => {
                    if (
                      node.type === 'folder' &&
                      e.dataTransfer.types.includes('application/x-node-id')
                    )
                      e.preventDefault()
                  }}
                  onDrop={(e) => {
                    const id = e.dataTransfer.getData('application/x-node-id')
                    if (id && node.type === 'folder') {
                      e.preventDefault()
                      onMove(id, node.id)
                    }
                  }}
                  onClick={() => !trashMode && editingId !== node.id && selectNode(node)}
                  onDoubleClick={() => !trashMode && node.type === 'folder' && openFolder(node)}
                >
                  <td>
                    <span className="node-icon">{node.type === 'folder' ? '📁' : '📄'}</span>{' '}
                    {editingId === node.id ? (
                      <input
                        className="name-input"
                        autoFocus
                        value={editingName}
                        onChange={(e) => setEditingName(e.target.value)}
                        onClick={(e) => e.stopPropagation()}
                        onFocus={(e) => e.currentTarget.select()}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault()
                            commitRename(node)
                          } else if (e.key === 'Escape') {
                            e.preventDefault()
                            cancelRename()
                          }
                        }}
                        onBlur={() => commitRename(node)}
                      />
                    ) : (
                      <span
                        className="node-name"
                        onDoubleClick={(e) => {
                          if (!trashMode) {
                            e.stopPropagation()
                            startRename(node)
                          }
                        }}
                      >
                        {node.name}
                      </span>
                    )}
                  </td>
                  <td className="col-date muted">{formatDateTime(node.created_at)}</td>
                  <td className="col-date muted">{formatDateTime(node.updated_at)}</td>
                  <td className="col-size muted">
                    {node.type === 'file' ? formatBytes(node.size) : '—'}
                  </td>
                  <td className="col-actions">
                    {trashMode ? (
                      <button
                        className="row-action"
                        onClick={() => guard(() => restoreNode(node.id))}
                      >
                        복원
                      </button>
                    ) : (
                      <>
                        <a href={downloadUrl(node)} onClick={(e) => e.stopPropagation()}>
                          <button className="row-action">↓</button>
                        </a>
                        <button
                          className="row-action"
                          onClick={(e) => {
                            e.stopPropagation()
                            startRename(node)
                          }}
                        >
                          이름
                        </button>
                        <button
                          className="row-action"
                          onClick={(e) => {
                            e.stopPropagation()
                            onDelete(node)
                          }}
                        >
                          삭제
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
              {sortedItems.length === 0 && (
                <tr>
                  <td colSpan={5} className="empty">
                    {trashMode
                      ? '휴지통이 비어 있습니다'
                      : '비어 있습니다 — 파일을 끌어다 놓거나 업로드를 누르세요'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </main>
      </div>

      {selected && selected.type === 'file' && !trashMode && (
        <>
          {!fullscreen && <div className="vsplit-handle" onPointerDown={viewerDrag} />}
          <div
            className="viewer-area"
            style={fullscreen ? { flex: 1, minHeight: 0 } : { height: viewerH }}
          >
            <ViewerPanel
              node={selected}
              fullscreen={fullscreen}
              onToggleFullscreen={() => setFullscreen((f) => !f)}
              onNodeUpdated={(fresh) => {
                setSelected(fresh)
                reload()
              }}
              onClose={() => {
                setSelected(null)
                setFullscreen(false)
                navigate(currentFolder ? `/files/${currentFolder.id}` : '/files')
              }}
            />
          </div>
        </>
      )}
    </div>
  )
}

function SortTh({
  label,
  col,
  cls,
  sortKey,
  sortDir,
  onSort,
}: {
  label: string
  col: SortKey
  cls?: string
  sortKey: SortKey
  sortDir: SortDir
  onSort: (k: SortKey) => void
}) {
  const active = sortKey === col
  return (
    <th className={`${cls ?? ''} th-sort${active ? ' active' : ''}`}>
      <button type="button" className="th-sort-btn" onClick={() => onSort(col)}>
        {label}
        <span className="sort-caret">{active ? (sortDir === 'asc' ? '▲' : '▼') : ''}</span>
      </button>
    </th>
  )
}
