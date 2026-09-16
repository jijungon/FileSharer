import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import FolderTree from '../components/FolderTree'
import LinkBar from '../components/LinkBar'
import NewMarkdownModal from '../components/NewMarkdownModal'
import ViewerPanel from '../components/ViewerPanel'
import { api, ApiError, Me, SpaceInfo } from '../lib/api'
import { downloadUrlData, supportsDragOut } from '../lib/dragout'
import { formatBytes, formatDateTime, formatTrashRemaining } from '../lib/format'
import {
  dropUploads,
  markUploadDone,
  partitionBySize,
  percent,
  runWithConcurrency,
  setProgress,
  uploadSummary,
  UploadItem,
} from '../lib/upload'
import {
  addFavorite,
  createFolder,
  deleteNode,
  downloadUrl,
  getNodePath,
  listFavoriteIds,
  listFavorites,
  listNodeChildren,
  listSpaceChildren,
  listTrash,
  copyNode,
  moveNode,
  NodeInfo,
  purgeNode,
  removeFavorite,
  renameNode,
  restoreNode,
  searchNodes,
  uploadFile,
} from '../lib/files'

type SortKey = 'name' | 'size' | 'created' | 'updated'
type SortDir = 'asc' | 'desc'

// 동시 업로드 개수 상한. 큰 파일(수백 MB)이 대역폭을 나눠 쓰므로 과하지 않게 3.
const UPLOAD_CONCURRENCY = 3

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
  const [uploads, setUploads] = useState<UploadItem[]>([])
  const [newMdName, setNewMdName] = useState<string | null>(null)
  const [searchQ, setSearchQ] = useState('')
  const [searchResults, setSearchResults] = useState<NodeInfo[] | null>(null) // null=검색 안 함
  const [favIds, setFavIds] = useState<Set<string>>(new Set()) // 내 즐겨찾기 노드 id
  const [favMode, setFavMode] = useState(false) // 즐겨찾기 뷰
  const [favItems, setFavItems] = useState<NodeInfo[]>([])
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
  const [checked, setChecked] = useState<Set<string>>(new Set()) // 다중선택된 노드 id
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

  const uploadStats = useMemo(() => uploadSummary(uploads), [uploads])

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
        const [meRes, spacesRes, cfg, favs] = await Promise.all([
          api<Me>('/api/me'),
          api<SpaceInfo[]>('/api/spaces'),
          api<{ max_upload_mb: number }>('/api/auth/config'),
          listFavoriteIds().catch(() => [] as string[]),
        ])
        setMe(meRes)
        setSpaces(spacesRes)
        setMaxUploadMb(cfg.max_upload_mb)
        setFavIds(new Set(favs))
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

  // 공간·폴더 이동이나 휴지통 토글 시 다중선택·검색 해제(다른 목록의 잔상 방지)
  useEffect(() => {
    setChecked(new Set())
    setSearchQ('')
  }, [spaceId, currentFolder?.id, trashMode])

  // 검색어 디바운스 → 현재 공간에서 이름 검색. 빈 문자열이면 검색 모드 해제.
  useEffect(() => {
    if (!spaceId) return
    const q = searchQ.trim()
    if (!q) {
      setSearchResults(null)
      return
    }
    let alive = true
    const timer = setTimeout(() => {
      searchNodes(spaceId, q)
        .then((rows) => alive && setSearchResults(rows))
        .catch(() => alive && setSearchResults([]))
    }, 300)
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [searchQ, spaceId])

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
    setFavMode(false)
    navigate('/files')
  }

  function openFolder(folder: NodeInfo) {
    setPath((p) => [...p, folder])
    setSelected(null)
    setFavMode(false)
    navigate(`/files/${folder.id}`)
  }

  function selectNode(node: NodeInfo) {
    setSelected(node)
    navigate(`/files/${node.id}`)
  }

  function crumbNavigate(index: number | null) {
    setSelected(null)
    setFullscreen(false)
    setFavMode(false)
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
      setFavMode(false)
      setPath(found.node.type === 'folder' ? [...found.ancestors, found.node] : found.ancestors)
      navigate(`/files/${id}`)
    } catch {
      flash('폴더를 열 수 없습니다')
    }
  }

  // 검색/즐겨찾기 결과 클릭: 폴더면 그 폴더로, 파일이면 경로 복원 후 뷰어로 연다.
  function openLocated(node: NodeInfo) {
    setSearchQ('') // 검색 모드 종료
    setFavMode(false) // 즐겨찾기 뷰 종료
    if (node.type === 'folder') openFolderById(node.id)
    else navigate(`/files/${node.id}`) // nav 이펙트가 경로 복원 + 뷰어 오픈
  }

  // 즐겨찾기 뷰 열기/토글
  async function toggleFavView() {
    if (favMode) {
      setFavMode(false)
      return
    }
    setTrashMode(false)
    setSelected(null)
    setSearchQ('')
    setFavMode(true)
    try {
      setFavItems(await listFavorites())
    } catch {
      setFavItems([])
    }
  }

  // 별표 토글(낙관적 업데이트 + 실패 시 롤백)
  async function toggleFav(node: NodeInfo) {
    const on = favIds.has(node.id)
    setFavIds((prev) => {
      const next = new Set(prev)
      if (on) next.delete(node.id)
      else next.add(node.id)
      return next
    })
    try {
      if (on) await removeFavorite(node.id)
      else await addFavorite(node.id)
      if (favMode && on) setFavItems((items) => items.filter((n) => n.id !== node.id))
    } catch (err) {
      setFavIds((prev) => {
        const next = new Set(prev)
        if (on) next.add(node.id)
        else next.delete(node.id)
        return next
      })
      flash(err instanceof Error ? err.message : '즐겨찾기 변경에 실패했습니다')
    }
  }

  async function onNewFolder() {
    const name = window.prompt('새 폴더 이름')
    if (!name || !spaceId) return
    await guard(() => createFolder(spaceId, currentFolder?.id ?? null, name))
  }

  // '새 MD'는 파일을 바로 만들지 않고 편집 모달을 연다(저장 시 생성, 취소 시 폐기).
  function onNewMd() {
    const raw = window.prompt('새 MD 문서 이름', '새 문서.md')
    if (!raw || !spaceId) return
    setNewMdName(raw.endsWith('.md') ? raw : `${raw}.md`)
  }

  async function createNewMd(content: string) {
    if (!spaceId || !newMdName) return
    const file = new File([content], newMdName, { type: 'text/markdown' })
    const created = await guard(() =>
      uploadFile({ spaceId, parentId: currentFolder?.id ?? null }, file),
    )
    setNewMdName(null)
    if (created) selectNode(created)
  }

  // 여러 파일을 최대 UPLOAD_CONCURRENCY개씩 병렬 업로드. 각 항목은 진행 패널에
  // 추가되고, 완료/실패로 표시된 뒤 배치가 끝나면 잠시 후 패널에서 제거된다.
  async function runUploads(entries: { file: File; relPath?: string }[]) {
    if (!spaceId || entries.length === 0) return
    const items = entries.map((e) => ({
      id: `${e.file.name}:${Date.now()}:${Math.random().toString(36).slice(2)}`,
      file: e.file,
      relPath: e.relPath,
    }))
    setUploads((u) => [
      ...u,
      ...items.map((it) => ({ id: it.id, name: it.file.name, loaded: 0, total: it.file.size })),
    ])
    let failed = 0
    await runWithConcurrency(items, UPLOAD_CONCURRENCY, async (it) => {
      try {
        await uploadFile(
          { spaceId: spaceId!, parentId: currentFolder?.id ?? null },
          it.file,
          it.relPath,
          (loaded, total) => setUploads((u) => setProgress(u, it.id, loaded, total)),
        )
        setUploads((u) => markUploadDone(u, it.id))
      } catch (err) {
        failed += 1
        setUploads((u) => markUploadDone(u, it.id, true))
        flash(err instanceof Error ? err.message : `${it.file.name} 업로드 실패`)
      }
    })
    reload()
    setTreeVersion((v) => v + 1) // 폴더가 새로 생겼을 수 있음(폴더 업로드)
    if (failed === 0) flash(`업로드 완료 (${items.length}개)`)
    // 완료 상태를 잠깐 보여준 뒤 이 배치 항목들을 패널에서 제거
    const ids = new Set(items.map((it) => it.id))
    setTimeout(() => setUploads((u) => dropUploads(u, ids)), 1500)
  }

  async function uploadAll(files: FileList | File[]) {
    if (!spaceId) return
    const { ok, tooBig } = partitionBySize(Array.from(files), maxUploadMb, (f) => f.size)
    if (tooBig.length)
      flash(`${maxUploadMb}MB 초과로 제외됨: ${tooBig.map((f) => f.name).join(', ')}`)
    // 폴더 선택 업로드면 webkitRelativePath에 'folder/sub/file' 경로가 담긴다
    await runUploads(ok.map((f) => ({ file: f, relPath: f.webkitRelativePath || undefined })))
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
    if (tooBig.length)
      flash(`${maxUploadMb}MB 초과로 제외됨: ${tooBig.map((c) => c.file.name).join(', ')}`)
    await runUploads(ok.map((c) => ({ file: c.file, relPath: c.relPath })))
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
    closeViewerIfAffected([draggedId]) // 열려 있던 파일을 옮겼으면 뷰어를 닫는다
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

  // 드래그 시작: 이 행이 체크돼 있고 여러 개 선택됐으면 선택 전체를, 아니면 이 항목만.
  function rowDragStart(e: React.DragEvent, node: NodeInfo) {
    const ids = checked.has(node.id) && checked.size > 1 ? [...checked] : [node.id]
    e.dataTransfer.setData('application/x-node-id', node.id) // 단일(드래그아웃 호환)
    e.dataTransfer.setData('application/x-node-ids', JSON.stringify(ids))
    if (supportsDragOut()) {
      e.dataTransfer.setData('DownloadURL', downloadUrlData(node, window.location.origin))
    }
    e.dataTransfer.effectAllowed = 'copyMove'
  }

  function draggedIds(e: React.DragEvent): string[] {
    const many = e.dataTransfer.getData('application/x-node-ids')
    if (many) {
      try {
        return JSON.parse(many) as string[]
      } catch {
        /* 단일로 폴백 */
      }
    }
    const one = e.dataTransfer.getData('application/x-node-id')
    return one ? [one] : []
  }

  // ── 다중선택 ──
  function toggleChecked(id: string) {
    setChecked((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  function clearChecked() {
    setChecked(new Set())
  }
  const allChecked = sortedItems.length > 0 && sortedItems.every((n) => checked.has(n.id))
  function toggleAll() {
    setChecked(allChecked ? new Set() : new Set(sortedItems.map((n) => n.id)))
  }

  // 이동·삭제한 항목이 지금 뷰어에 열려 있으면 닫는다.
  // (다중 이동 후 옮긴 파일이 뷰어에 잔상처럼 남아 보이던 문제 방지)
  function closeViewerIfAffected(ids: Iterable<string>) {
    const set = ids instanceof Set ? ids : new Set(ids)
    if (selected && set.has(selected.id)) {
      setSelected(null)
      setFullscreen(false)
    }
  }

  async function onMoveMany(ids: string[], targetFolderId: string | null) {
    if (!spaceId) return
    try {
      for (const id of ids) {
        if (id !== targetFolderId) {
          await moveNode(id, targetFolderId ? { parentId: targetFolderId } : { spaceId })
        }
      }
    } catch (err) {
      flash(err instanceof Error ? err.message : '이동에 실패했습니다')
    } finally {
      closeViewerIfAffected(ids)
      clearChecked()
      reload()
      setTreeVersion((v) => v + 1)
    }
  }

  async function copyManyToSpace(ids: string[], targetSpaceId: string, spaceName: string) {
    if (targetSpaceId === spaceId) return
    let done = 0
    try {
      for (const id of ids) {
        if (id !== targetSpaceId) {
          await copyNode(id, { spaceId: targetSpaceId })
          done += 1
        }
      }
      if (done) flash(`${spaceName}(으)로 ${done}개 복사했습니다`)
    } catch (err) {
      flash(err instanceof Error ? err.message : '복사에 실패했습니다')
    } finally {
      clearChecked()
    }
  }

  async function bulkDelete() {
    const ids = [...checked]
    if (ids.length === 0) return
    if (!window.confirm(`선택한 ${ids.length}개를 휴지통으로 이동할까요?`)) return
    try {
      for (const id of ids) await deleteNode(id)
    } catch (err) {
      flash(err instanceof Error ? err.message : '삭제에 실패했습니다')
    } finally {
      closeViewerIfAffected(ids)
      clearChecked()
      reload()
      setTreeVersion((v) => v + 1)
    }
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
                  const ids = draggedIds(e)
                  setDragOverSpace(null)
                  if (ids.length === 0) return
                  e.preventDefault()
                  // 활성 공간 위에 놓으면 그 공간 최상위로 이동, 다른 공간이면 복사
                  if (s.id === spaceId) {
                    if (ids.length > 1) onMoveMany(ids, null)
                    else onMove(ids[0], null)
                  } else if (ids.length > 1) copyManyToSpace(ids, s.id, s.name)
                  else copyToSpace(ids[0], s.id, s.name)
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
              className={`space-item${favMode ? ' active' : ''}`}
              onClick={toggleFavView}
            >
              ★ 즐겨찾기
            </button>
            <button
              className={`space-item${trashMode ? ' active' : ''}`}
              onClick={() => {
                setTrashMode((t) => !t)
                setFavMode(false)
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
            {!trashMode && !favMode && (
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
            {favMode && <span className="muted">즐겨찾기 — ★ 를 눌러 해제, 항목을 눌러 이동</span>}
            <span className="toolbar-notice">{notice}</span>
            {!trashMode && !favMode && (
              <div className="toolbar-search">
                <input
                  type="search"
                  className="search-input"
                  placeholder="이 공간에서 검색"
                  value={searchQ}
                  onChange={(e) => setSearchQ(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') setSearchQ('')
                  }}
                  aria-label="이 공간에서 검색"
                />
              </div>
            )}
          </div>

          {favMode ? (
            <div className="search-results">
              <div className="search-results-head muted">
                {favItems.length > 0
                  ? `즐겨찾기 ${favItems.length}개`
                  : '즐겨찾기한 항목이 없습니다 — 목록에서 ☆ 를 눌러 추가하세요'}
              </div>
              <ul className="search-results-list">
                {favItems.map((node) => (
                  <li
                    key={node.id}
                    className="search-result"
                    onClick={() => openLocated(node)}
                  >
                    <button
                      className="fav-star on"
                      title="즐겨찾기 해제"
                      aria-label="즐겨찾기 해제"
                      onClick={(e) => {
                        e.stopPropagation()
                        toggleFav(node)
                      }}
                    >
                      ★
                    </button>
                    <span className="node-icon">{node.type === 'folder' ? '📁' : '📄'}</span>
                    <span className="search-result-name">{node.name}</span>
                    <span className="search-result-path muted">
                      {node.path ? node.path : '(루트)'}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : searchResults !== null ? (
            <div className="search-results">
              <div className="search-results-head muted">
                {searchResults.length > 0
                  ? `"${searchQ.trim()}" 검색 결과 ${searchResults.length}개`
                  : `"${searchQ.trim()}"에 대한 결과가 없습니다`}
              </div>
              <ul className="search-results-list">
                {searchResults.map((node) => (
                  <li
                    key={node.id}
                    className="search-result"
                    onClick={() => openLocated(node)}
                  >
                    <span className="node-icon">{node.type === 'folder' ? '📁' : '📄'}</span>
                    <span className="search-result-name">{node.name}</span>
                    <span className="search-result-path muted">
                      {node.path ? node.path : '(루트)'}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
          <table className="file-table">
            <thead>
              <tr>
                <th className="col-check">
                  {!trashMode && (
                    <input
                      type="checkbox"
                      aria-label="전체 선택"
                      checked={allChecked}
                      onChange={toggleAll}
                    />
                  )}
                </th>
                <SortTh label="이름" col="name" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                <SortTh
                  label="올린 날짜"
                  col="created"
                  cls="col-date"
                  sortKey={sortKey}
                  sortDir={sortDir}
                  onSort={toggleSort}
                />
                {trashMode ? (
                  // 휴지통에선 '수정한 날짜' 대신 '삭제 예정' 열(남은 시간 정렬 정돈)
                  <th className="col-remaining">삭제 예정</th>
                ) : (
                  <SortTh
                    label="수정한 날짜"
                    col="updated"
                    cls="col-date"
                    sortKey={sortKey}
                    sortDir={sortDir}
                    onSort={toggleSort}
                  />
                )}
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
                    const ids = draggedIds(e)
                    if (ids.length > 0) {
                      e.preventDefault()
                      const target = currentFolder.parent_id ?? null
                      if (ids.length > 1) onMoveMany(ids, target)
                      else onMove(ids[0], target)
                    }
                  }}
                >
                  <td className="col-check"></td>
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
                  className={
                    (selected?.id === node.id ? 'row-selected' : '') +
                    (checked.has(node.id) ? ' row-checked' : '')
                  }
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
                    const ids = draggedIds(e)
                    if (ids.length > 0 && node.type === 'folder') {
                      e.preventDefault()
                      if (ids.length > 1) onMoveMany(ids, node.id)
                      else onMove(ids[0], node.id)
                    }
                  }}
                  onClick={() => {
                    if (trashMode || editingId === node.id) return
                    // 이미 선택 모드면 행 클릭이 체크 토글, 아니면 뷰어로 열기
                    if (checked.size > 0) toggleChecked(node.id)
                    else selectNode(node)
                  }}
                  onDoubleClick={() => !trashMode && node.type === 'folder' && openFolder(node)}
                >
                  <td className="col-check">
                    {!trashMode && (
                      <input
                        type="checkbox"
                        // 라벨에 파일명을 넣지 않는다 — 넣으면 이 셀의 접근성 이름이
                        // "파일명 선택"이 되어 이름으로 셀/행을 찾는 기존 테스트와 충돌한다.
                        aria-label="행 선택"
                        checked={checked.has(node.id)}
                        onClick={(e) => e.stopPropagation()}
                        onChange={() => toggleChecked(node.id)}
                      />
                    )}
                  </td>
                  <td>
                    {!trashMode && (
                      <button
                        className={`fav-star${favIds.has(node.id) ? ' on' : ''}`}
                        title={favIds.has(node.id) ? '즐겨찾기 해제' : '즐겨찾기'}
                        aria-label={favIds.has(node.id) ? '즐겨찾기 해제' : '즐겨찾기'}
                        onClick={(e) => {
                          e.stopPropagation()
                          toggleFav(node)
                        }}
                      >
                        {favIds.has(node.id) ? '★' : '☆'}
                      </button>
                    )}
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
                  {trashMode ? (
                    <td className="col-remaining">
                      <TrashRemaining purgeAt={node.purge_at} />
                    </td>
                  ) : (
                    <td className="col-date muted">{formatDateTime(node.updated_at)}</td>
                  )}
                  <td className="col-size muted">
                    {node.type === 'file' ? formatBytes(node.size) : '—'}
                  </td>
                  <td className="col-actions">
                    {trashMode ? (
                      <>
                        <button
                          className="row-action"
                          onClick={() => guard(() => restoreNode(node.id))}
                        >
                          복원
                        </button>
                        <button
                          className="row-action danger"
                          onClick={() => {
                            if (
                              window.confirm(
                                `"${node.name}"을(를) 완전히 삭제할까요? 되돌릴 수 없습니다.`,
                              )
                            )
                              guard(() => purgeNode(node.id))
                          }}
                        >
                          완전 삭제
                        </button>
                      </>
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
                  <td colSpan={6} className="empty">
                    {trashMode
                      ? '휴지통이 비어 있습니다'
                      : '비어 있습니다 — 파일을 끌어다 놓거나 업로드를 누르세요'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          )}
        </main>
      </div>

      {selected && selected.type === 'file' && !trashMode && !favMode && checked.size === 0 && (
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
      {!trashMode && checked.size > 0 && (
        <div className="bulk-bar" aria-label="선택 항목">
          <div className="bulk-bar-head">
            <strong>{checked.size}개 선택됨</strong>
            <span className="muted">
              폴더 행이나 왼쪽 공간으로 끌어다 놓으면 이동·복사됩니다
            </span>
            <div className="bulk-bar-actions">
              <button className="btn-utility danger" onClick={bulkDelete}>
                🗑 선택 삭제
              </button>
              <button className="btn-utility" onClick={clearChecked}>
                선택 해제
              </button>
            </div>
          </div>
          <ul className="bulk-bar-list">
            {sortedItems
              .filter((n) => checked.has(n.id))
              .map((n) => (
                <li key={n.id}>
                  <span className="node-icon">{n.type === 'folder' ? '📁' : '📄'}</span>
                  <span className="node-name">{n.name}</span>
                  <button
                    className="bulk-remove"
                    title="목록에서 빼기"
                    onClick={() => toggleChecked(n.id)}
                  >
                    ×
                  </button>
                </li>
              ))}
          </ul>
        </div>
      )}
      {uploads.length > 0 && (
        <div className="upload-progress" aria-label="업로드 진행">
          <div className="upload-progress-head">
            <span>
              업로드 {uploadStats.done}/{uploadStats.total}
              {uploadStats.failed > 0 && ` · 실패 ${uploadStats.failed}`}
            </span>
            <span className="upload-progress-pct">{uploadStats.percent}%</span>
          </div>
          {uploads.map((u) => (
            <div
              key={u.id}
              className={`upload-progress-row${u.error ? ' error' : u.done ? ' done' : ''}`}
            >
              <span className="upload-progress-name" title={u.name}>
                {u.name}
              </span>
              <progress className="upload-progress-bar" value={u.loaded} max={u.total || 1} />
              <span className="upload-progress-pct">{u.error ? '실패' : `${percent(u)}%`}</span>
            </div>
          ))}
        </div>
      )}
      {newMdName && (
        <NewMarkdownModal
          name={newMdName}
          onCancel={() => setNewMdName(null)}
          onCreate={createNewMd}
        />
      )}
    </div>
  )
}

// 휴지통 행에 "완전삭제까지 N일 남음"을 보여주는 칩. 예정 시각이 없으면 렌더 안 함.
function TrashRemaining({ purgeAt }: { purgeAt?: string | null }) {
  const text = formatTrashRemaining(purgeAt)
  if (!text) return null
  return (
    <span
      className={`trash-remaining${text === '곧 삭제됨' ? ' soon' : ''}`}
      title={purgeAt ? `자동 완전삭제 예정: ${formatDateTime(purgeAt)}` : undefined}
    >
      {text}
    </span>
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
