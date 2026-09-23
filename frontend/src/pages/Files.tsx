import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { Link, useNavigate, useParams } from 'react-router-dom'
import FolderTree from '../components/FolderTree'
import LinkBar from '../components/LinkBar'
import NameModal from '../components/NameModal'
import NewMarkdownModal from '../components/NewMarkdownModal'
import ViewerPanel, { FileActions } from '../components/ViewerPanel'
import { api, ApiError, Me, SpaceInfo } from '../lib/api'
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
  TreeRow,
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

// 툴바용 라인 아이콘(VS Code풍, currentColor 단색). stroke 기반이라 테마색을 따른다.
const svgProps = {
  width: 16,
  height: 16,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
}
function IconRefresh({ className }: { className?: string }) {
  return (
    <svg {...svgProps} className={className}>
      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
      <path d="M21 3v6h-6" />
    </svg>
  )
}
function IconFolderPlus() {
  return (
    <svg {...svgProps}>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <line x1="12" y1="11" x2="12" y2="17" />
      <line x1="9" y1="14" x2="15" y2="14" />
    </svg>
  )
}
function IconFilePlus() {
  return (
    <svg {...svgProps}>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <polyline points="14 3 14 8 19 8" />
      <line x1="12" y1="12" x2="12" y2="18" />
      <line x1="9" y1="15" x2="15" y2="15" />
    </svg>
  )
}

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
  // 화면 테마(다크 기본 ↔ 라이트). data-theme로 토큰을 뒤집고 localStorage에 기억한다.
  const [theme, setTheme] = useState<'dark' | 'light'>(() =>
    document.documentElement.dataset.theme === 'light' ? 'light' : 'dark',
  )
  const [spaces, setSpaces] = useState<SpaceInfo[]>([])
  const [spaceId, setSpaceId] = useState<string | null>(null)
  const [path, setPath] = useState<NodeInfo[]>([])
  const [items, setItems] = useState<NodeInfo[]>([])
  const [selected, setSelected] = useState<NodeInfo | null>(null)
  // 다중 탭: 열린 파일 목록 + 미저장 탭 집합. selected(활성 파일)는 그대로 두고 위에 얹는다.
  const [openTabs, setOpenTabs] = useState<NodeInfo[]>([])
  const [dirtyTabs, setDirtyTabs] = useState<Set<string>>(new Set())
  const [trashMode, setTrashMode] = useState(false)
  const [notice, setNotice] = useState('')
  const [maxUploadMb, setMaxUploadMb] = useState(0)
  const [uploads, setUploads] = useState<UploadItem[]>([])
  const [newMdName, setNewMdName] = useState<string | null>(null)
  // 새 폴더/새 MD 이름 입력 모달(window.prompt 대체)
  const [nameModal, setNameModal] = useState<{
    title: string
    initial?: string
    onSubmit: (name: string) => void
  } | null>(null)
  const [searchQ, setSearchQ] = useState('')
  const [searchResults, setSearchResults] = useState<NodeInfo[] | null>(null) // null=검색 안 함
  const [searchFocused, setSearchFocused] = useState(false) // 상단 검색 드롭다운 열림 여부
  const [searchIdx, setSearchIdx] = useState(-1) // 키보드로 하이라이트한 결과(-1=없음)
  const searchRef = useRef<HTMLDivElement>(null)
  const [favIds, setFavIds] = useState<Set<string>>(new Set()) // 내 즐겨찾기 노드 id
  const [favMode, setFavMode] = useState(false) // 즐겨찾기 뷰
  const [favItems, setFavItems] = useState<NodeInfo[]>([])
  const [dropActive, setDropActive] = useState(false)
  const [bootError, setBootError] = useState('')
  // 지금 메모리에 든 임시 토큰 원문 — 서버 업로드 curl 자동 채움용. 새로고침/해제하면 사라진다.
  const [activeToken, setActiveToken] = useState<string | null>(null)
  const [sortKey, setSortKey] = useState<SortKey>('name')
  const [sortDir, setSortDir] = useState<SortDir>('asc')
  const [dragOverSpace, setDragOverSpace] = useState<string | null>(null)
  const [dragOverTrash, setDragOverTrash] = useState(false)
  const [treeVersion, setTreeVersion] = useState(0)
  const [refreshing, setRefreshing] = useState(false) // 새로고침 버튼 회전 표시
  // 사이드바 폭(드래그로 조절, localStorage 기억). 잘린 파일 이름을 넓혀 보기 위함.
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    try {
      const v = parseInt(localStorage.getItem('fs:sidebarW') || '', 10)
      return v >= 160 && v <= 560 ? v : 220
    } catch {
      return 220
    }
  })
  const fileInput = useRef<HTMLInputElement>(null)
  const tabBarRef = useRef<HTMLDivElement>(null) // 탭 스트립 가로 스크롤/드래그
  const tabDrag = useRef<{ x: number; scroll: number; moved: boolean } | null>(null)
  // 탭 줄 오른쪽 '저장/자동저장' 슬롯 — 활성 편집기가 이 DOM으로 portal 렌더한다(Stage B)
  const [actionSlot, setActionSlot] = useState<HTMLDivElement | null>(null)
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

  function toggleTheme() {
    const next = theme === 'dark' ? 'light' : 'dark'
    setTheme(next)
    document.documentElement.dataset.theme = next
    try {
      localStorage.setItem('fs:theme', next)
    } catch {
      /* localStorage 불가 — 세션 동안만 적용 */
    }
  }

  // 사이드바 우측 경계선을 드래그해 폭 조절(160~560px). 놓을 때 localStorage에 저장.
  function startSidebarResize(e: React.PointerEvent) {
    e.preventDefault()
    const startX = e.clientX
    const startW = sidebarWidth
    let lastW = startW
    const overlay = document.createElement('div')
    overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;cursor:col-resize'
    document.body.appendChild(overlay)
    function move(ev: PointerEvent) {
      lastW = Math.min(560, Math.max(160, startW + (ev.clientX - startX)))
      setSidebarWidth(lastW)
    }
    function up() {
      overlay.remove()
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      try {
        localStorage.setItem('fs:sidebarW', String(lastW))
      } catch {
        /* localStorage 불가 — 세션 동안만 적용 */
      }
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
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
        // nodeId가 없으면(루트/뷰) 저장된 공간·뷰로 복원 — 새로고침해도 위치가 유지된다.
        let saved: { spaceId?: string; view?: string } = {}
        try {
          saved = JSON.parse(localStorage.getItem('fs:view') || '{}')
        } catch {
          /* localStorage 불가 — 기본값 사용 */
        }
        const savedSpace = spacesRes.find((s) => s.id === saved.spaceId)?.id
        setSpaceId((prev) => prev ?? savedSpace ?? spacesRes[0]?.id ?? null)
        if (saved.view === 'fav') {
          setFavMode(true)
          listFavorites()
            .then(setFavItems)
            .catch(() => setFavItems([]))
        } else if (saved.view === 'trash') {
          setTrashMode(true)
        }
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

  // 현재 공간·뷰를 기억해 둔다(새로고침 복원용). 루트/뷰(최근·즐겨찾기·휴지통·전체공간)는
  // URL에 안 담기므로 localStorage에 저장 → 부팅 시 위 boot()가 복원한다.
  useEffect(() => {
    if (!navSynced.current || !spaceId) return
    const view = trashMode ? 'trash' : favMode ? 'fav' : 'normal'
    try {
      localStorage.setItem('fs:view', JSON.stringify({ spaceId, view }))
    } catch {
      /* localStorage 불가 — 저장 생략 */
    }
  }, [spaceId, trashMode, favMode])

  // 브라우저 뒤로/앞으로: URL(nodeId)이 화면 상태와 어긋나면 URL을 기준으로 복원.
  // 앞으로 이동(폴더 열기 등)은 상태를 먼저 세팅하므로 currentId === nodeId라 건너뛴다.
  useEffect(() => {
    if (!navSynced.current) return
    const currentId = selected?.id ?? currentFolder?.id ?? null
    if ((nodeId ?? null) === currentId) return
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

  // 새로고침 버튼: 현재 보고 있는 목록 + 사이드바 인라인 최근 + 폴더 트리를 다시 불러온다.
  async function refreshCurrent() {
    if (refreshing) return
    setRefreshing(true)
    try {
      if (favMode) setFavItems(await listFavorites())
      else await reload()
      setTreeVersion((v) => v + 1) // 사이드바 폴더 트리도 갱신
    } catch {
      /* reload/loader 내부에서 에러 표시 처리 */
    } finally {
      setRefreshing(false)
    }
  }


  // 공간·폴더 이동이나 휴지통 토글 시 검색 해제(다른 목록의 잔상 방지)
  useEffect(() => {
    setSearchQ('')
  }, [spaceId, currentFolder?.id, trashMode])

  // 활성 파일이 바뀌면 탭 목록에 추가(없으면)하거나 최신 node로 갱신한다.
  useEffect(() => {
    if (!selected || selected.type !== 'file') return
    setOpenTabs((tabs) => {
      const i = tabs.findIndex((t) => t.id === selected.id)
      if (i === -1) return [...tabs, selected]
      const next = tabs.slice()
      next[i] = selected // 이름·수정시각 갱신
      return next
    })
  }, [selected])

  // 탭 클릭 → 그 파일을 활성화(URL도 그 파일로 → URL 동기화가 path/space 맞춰줌).
  function activateTab(node: NodeInfo) {
    setSelected(node)
    navigate(`/files/${node.id}`)
  }

  // 탭 닫기(미저장이면 확인). 닫는 게 활성 탭이면 이웃으로 활성 이동, 없으면 뷰어를 닫는다.
  function closeTab(id: string, force = false) {
    if (!force && dirtyTabs.has(id)) {
      if (!window.confirm('저장하지 않은 변경이 있습니다. 이 탭을 닫을까요?')) return
    }
    const i = openTabs.findIndex((t) => t.id === id)
    const next = openTabs.filter((t) => t.id !== id)
    setOpenTabs(next)
    setDirtyTabs((d) => {
      if (!d.has(id)) return d
      const n = new Set(d)
      n.delete(id)
      return n
    })
    if (selected?.id === id) {
      const neighbor = next[i] ?? next[i - 1] ?? null
      if (neighbor) {
        setSelected(neighbor)
        navigate(`/files/${neighbor.id}`)
      } else {
        setSelected(null)
        navigate(currentFolder ? `/files/${currentFolder.id}` : '/files')
      }
    }
  }

  // 탭별 미저장 표시(●) — TextEditor가 dirty 여부를 올려준다.
  function setTabDirty(id: string, dirty: boolean) {
    setDirtyTabs((d) => {
      if (d.has(id) === dirty) return d
      const n = new Set(d)
      if (dirty) n.add(id)
      else n.delete(id)
      return n
    })
  }

  // 검색어 디바운스 → 현재 공간에서 이름·내용 검색. 빈 문자열이면 검색 모드 해제.
  // 예외: 사내 링크/해시(32자리 hex)를 붙여넣으면 그 파일을 바로 결과로 띄운다(📋 해시 복사와 짝).
  useEffect(() => {
    if (!spaceId) return
    const q = searchQ.trim()
    if (!q) {
      setSearchResults(null)
      return
    }
    let alive = true
    const idMatch = q.match(/([0-9a-f]{32})/i)
    if (idMatch) {
      getNodePath(idMatch[1])
        .then((found) => {
          if (alive)
            setSearchResults([
              { ...found.node, path: found.ancestors.map((a) => a.name).join('/') },
            ])
        })
        .catch(() => alive && setSearchResults([]))
      return () => {
        alive = false
      }
    }
    const timer = setTimeout(() => {
      // 현재 공간만이 아니라 접근 가능한 모든 공간에서 찾아 합친다.
      const targetIds = spaces.length > 0 ? spaces.map((s) => s.id) : [spaceId]
      const nameOf = (id: string) => spaces.find((s) => s.id === id)?.name ?? ''
      Promise.all(targetIds.map((id) => searchNodes(id, q).catch(() => [] as NodeInfo[])))
        .then((perSpace) => {
          if (!alive) return
          const seen = new Set<string>()
          const merged: NodeInfo[] = []
          for (const rows of perSpace) {
            for (const n of rows) {
              if (seen.has(n.id)) continue
              seen.add(n.id)
              // 여러 공간을 한꺼번에 보여주므로 경로 앞에 공간 이름을 붙여 구분한다.
              merged.push({ ...n, path: [nameOf(n.space_id), n.path].filter(Boolean).join('/') })
            }
          }
          setSearchResults(merged)
        })
        .catch(() => alive && setSearchResults([]))
    }, 300)
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [searchQ, spaceId, spaces])

  // 검색 결과가 바뀌면 키보드 하이라이트를 초기화(Enter는 없으면 첫 결과를 연다)
  useEffect(() => {
    setSearchIdx(-1)
  }, [searchResults])

  // 하이라이트한 결과를 드롭다운 안에서 보이게 스크롤
  useEffect(() => {
    if (searchIdx < 0) return
    searchRef.current?.querySelector('.search-result.active')?.scrollIntoView({ block: 'nearest' })
  }, [searchIdx])

  // 검색창 바깥을 누르면 드롭다운을 닫고 포커스를 바깥으로 넘긴다
  useEffect(() => {
    if (!searchFocused) return
    function onDown(e: MouseEvent) {
      if (searchRef.current && !searchRef.current.contains(e.target as Node)) {
        setSearchFocused(false)
      }
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [searchFocused])

  // 검색 결과 선택 → 그 파일을 열고 검색을 닫는다(클릭·Enter 공통)
  function openSearchResult(node: NodeInfo) {
    openLocated(node)
    setSearchQ('')
    setSearchFocused(false)
    setSearchIdx(-1)
  }

  function flash(msg: string) {
    setNotice(msg)
    setTimeout(() => setNotice(''), 2500)
  }

  function switchSpace(id: string) {
    setSpaceId(id)
    setPath([])
    setSelected(null)
    setTrashMode(false)
    setFavMode(false)
    navigate('/files')
  }

  function selectNode(node: NodeInfo) {
    setSelected(node)
    navigate(`/files/${node.id}`)
  }

  function crumbNavigate(index: number | null) {
    setSelected(null)
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
      setSpaceId(found.space_id) // 다른 공간의 폴더를 눌러도 그 공간으로 전환
      setSelected(null)
      setTrashMode(false)
      setFavMode(false)
      setPath(found.node.type === 'folder' ? [...found.ancestors, found.node] : found.ancestors)
      navigate(`/files/${id}`)
    } catch {
      flash('폴더를 열 수 없습니다')
    }
  }

  // 검색/즐겨찾기/최근 결과 클릭: 폴더면 그 폴더로, 파일이면 경로 복원 후 뷰어로 연다.
  async function openLocated(node: NodeInfo) {
    setSearchQ('') // 검색 모드 종료
    setFavMode(false) // 즐겨찾기 뷰 종료
    setTrashMode(false) // 휴지통 모드였어도 벗어나 뷰어/폴더를 연다
    if (node.type === 'folder') {
      openFolderById(node.id)
      return
    }
    // 파일: 경로/선택을 직접 세팅해 뷰어를 연다(URL이 이미 같아도 확실히 열리게).
    try {
      const found = await getNodePath(node.id)
      setSpaceId(found.space_id)
      setPath(found.ancestors)
      setSelected(found.node)
      navigate(`/files/${node.id}`)
    } catch {
      flash('항목을 열 수 없습니다')
    }
  }

  // 사이드바 트리에서 파일 클릭 → 뷰어로 연다(TreeRow만으로 동작, openLocated 파일 분기와 동일)
  async function openFileFromTree(row: TreeRow) {
    setSearchQ('')
    setFavMode(false)
    setTrashMode(false) // 휴지통 모드에서 트리 파일을 눌러도 뷰어가 열리게
    try {
      const found = await getNodePath(row.id)
      setSpaceId(found.space_id)
      setPath(found.ancestors)
      setSelected(found.node)
      navigate(`/files/${row.id}`)
    } catch {
      flash('항목을 열 수 없습니다')
    }
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
    setPath([]) // 루트 뷰 진입: URL nodeId 비우기(새로고침 복원, [nodeId] 효과의 모드 리셋 방지)
    navigate('/files')
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

  // 이름 입력은 window.prompt 대신 인라인 모달(NameModal)로 — prompt 미지원/차단 환경 대응.
  function onNewFolder() {
    if (!spaceId) return
    setNameModal({
      title: '새 폴더',
      onSubmit: (name) => {
        setNameModal(null)
        void guard(() => createFolder(spaceId, currentFolder?.id ?? null, name))
      },
    })
  }

  // '새 MD'는 파일을 바로 만들지 않고 편집 모달을 연다(저장 시 생성, 취소 시 폐기).
  function onNewMd() {
    if (!spaceId) return
    setNameModal({
      title: '새 MD 문서',
      initial: '새 문서.md',
      onSubmit: (raw) => {
        setNameModal(null)
        setNewMdName(raw.endsWith('.md') ? raw : `${raw}.md`)
      },
    })
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
  async function runUploads(
    entries: { file: File; relPath?: string }[],
    target?: { spaceId: string; parentId: string | null },
  ) {
    // 대상 미지정이면 '지금 보고 있는 위치'. 지정되면(트리 폴더/공간 드롭) 그 위치로.
    const dest = target ?? { spaceId: spaceId ?? '', parentId: currentFolder?.id ?? null }
    if (!dest.spaceId || entries.length === 0) return
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
          { spaceId: dest.spaceId, parentId: dest.parentId },
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
    setTreeVersion((v) => v + 1) // 폴더가 새로 생겼을 수 있음(폴더 업로드)
    if (failed === 0) flash(`업로드 완료 (${items.length}개)`)
    // 실제 목록을 받아오며 업로드 행을 같은 렌더에서 교체(중간 상태로 같은
    // 파일이 두 번 보이지 않게). flushSync로 setItems+제거를 한 커밋에 묶는다.
    const ids = new Set(items.map((it) => it.id))
    // 드롭 대상이 '지금 보고 있는 위치'일 때만 현재 목록을 즉시 새로고침(다른 폴더면 트리만 갱신).
    const isCurrentDest =
      dest.spaceId === spaceId && dest.parentId === (currentFolder?.id ?? null)
    let fresh: NodeInfo[] | null = null
    if (isCurrentDest) {
      try {
        fresh = currentFolder
          ? await listNodeChildren(currentFolder.id)
          : await listSpaceChildren(dest.spaceId)
      } catch {
        /* 목록 새로고침 실패는 무시 — 다음 네비게이션에서 갱신됨 */
      }
    }
    flushSync(() => {
      if (fresh) setItems(fresh)
      setUploads((u) => dropUploads(u, ids))
    })
  }

  async function uploadAll(
    files: FileList | File[],
    target?: { spaceId: string; parentId: string | null },
  ) {
    if (!spaceId && !target) return
    const { ok, tooBig } = partitionBySize(Array.from(files), maxUploadMb, (f) => f.size)
    if (tooBig.length)
      flash(`${maxUploadMb}MB 초과로 제외됨: ${tooBig.map((f) => f.name).join(', ')}`)
    // 폴더 선택 업로드면 webkitRelativePath에 'folder/sub/file' 경로가 담긴다
    await runUploads(
      ok.map((f) => ({ file: f, relPath: f.webkitRelativePath || undefined })),
      target,
    )
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

  async function uploadDropped(
    entries: FileSystemEntry[],
    target?: { spaceId: string; parentId: string | null },
  ) {
    if (!spaceId && !target) return
    const collected: { file: File; relPath: string }[] = []
    for (const entry of entries) await walkEntry(entry, '', collected)
    const { ok, tooBig } = partitionBySize(collected, maxUploadMb, (c) => c.file.size)
    if (tooBig.length)
      flash(`${maxUploadMb}MB 초과로 제외됨: ${tooBig.map((c) => c.file.name).join(', ')}`)
    await runUploads(ok.map((c) => ({ file: c.file, relPath: c.relPath })), target)
  }

  // 드롭 이벤트에서 로컬 파일/폴더를 '동기적으로' 뽑아낸다(핸들러 종료 후 items가 무효화됨).
  function extractDrop(e: React.DragEvent): { entries: FileSystemEntry[]; files: File[] } {
    const entries = e.dataTransfer.items
      ? Array.from(e.dataTransfer.items)
          .map((it) => it.webkitGetAsEntry?.() ?? null)
          .filter((x): x is FileSystemEntry => x !== null)
      : []
    return { entries, files: Array.from(e.dataTransfer.files) }
  }

  // 트리의 특정 폴더·공간 위로 로컬 파일/폴더를 드롭 → 그 위치로 업로드(다중·폴더 재귀 지원).
  function uploadToTarget(
    target: { spaceId: string; parentId: string | null },
    e: React.DragEvent,
  ) {
    const { entries, files } = extractDrop(e)
    if (entries.length > 0) uploadDropped(entries, target)
    else if (files.length > 0) uploadAll(files, target)
  }

  // 드래그로 휴지통에 놓아 삭제(복원 가능하므로 확인창 없음).
  async function trashByDrag(ids: string[]) {
    if (ids.length === 0) return
    try {
      for (const id of ids) await deleteNode(id)
    } catch (err) {
      flash(err instanceof Error ? err.message : '삭제에 실패했습니다')
    } finally {
      closeViewerIfAffected(ids)
      reload()
      setTreeVersion((v) => v + 1)
    }
  }

  // ── 사이드바 트리 우클릭 메뉴 동작(파일목록 표 대체) ──
  // 인라인 이름변경 커밋(빈/동일 이름 무시는 FolderTree 쪽에서 처리) — guard가 reload + treeVersion 갱신
  function renameCommit(row: TreeRow, name: string) {
    void guard(() => renameNode(row.id, name))
  }
  async function deleteFromTree(row: TreeRow) {
    if (!window.confirm(`"${row.name}"을(를) 휴지통으로 이동할까요?`)) return
    await guard(() => deleteNode(row.id))
    closeTab(row.id, true) // 열려 있던 탭이면 닫기(활성이면 이웃으로 이동)
  }
  // 뷰어 액션 바의 🗑 삭제 — 그 파일을 휴지통으로 이동하고 해당 탭을 닫는다.
  async function deleteTab(node: NodeInfo) {
    if (!window.confirm(`"${node.name}"을(를) 휴지통으로 이동할까요?`)) return
    await guard(() => deleteNode(node.id))
    closeTab(node.id, true)
  }
  function toggleFavFromTree(row: TreeRow) {
    // toggleFav는 node.id만 사용 — TreeRow에 NodeInfo 필수 필드만 채워 넘긴다
    toggleFav({ ...row, space_id: spaceId ?? '', created_at: null, updated_at: null })
  }

  // 드래그 항목을 폴더/공간에 놓았을 때: 같은 공간이면 이동, 다른 공간이면 복사(원본 유지).
  // 판단 기준은 "드래그한 파일의 실제 공간(srcSpaceId) vs 놓은 대상의 공간" — 활성 공간이 아니다.
  // (두 공간 트리를 동시에 보여준 뒤로, 활성 공간 기준 판단은 크로스공간 드롭을 이동으로 오판했다.)
  async function dropNode(
    draggedId: string,
    target: { spaceId: string; folderId?: string | null; spaceName?: string },
    srcSpaceId?: string,
  ) {
    const folderId = target.folderId ?? null
    if (draggedId === folderId) return
    if (srcSpaceId && srcSpaceId !== target.spaceId) {
      // 다른 공간 → 복사
      const ok = await guard(() =>
        copyNode(draggedId, folderId ? { parentId: folderId } : { spaceId: target.spaceId }),
      )
      if (ok) flash(target.spaceName ? `${target.spaceName}(으)로 복사했습니다` : '복사했습니다')
    } else {
      // 같은 공간 → 이동
      await guard(() =>
        moveNode(draggedId, folderId ? { parentId: folderId } : { spaceId: target.spaceId }),
      )
      closeViewerIfAffected([draggedId]) // 열려 있던 파일을 옮겼으면 뷰어를 닫는다
    }
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

  // 이동·삭제한 항목이 지금 뷰어에 열려 있으면 닫는다.
  // (다중 이동 후 옮긴 파일이 뷰어에 잔상처럼 남아 보이던 문제 방지)
  function closeViewerIfAffected(ids: Iterable<string>) {
    const set = ids instanceof Set ? ids : new Set(ids)
    const remaining = openTabs.filter((t) => !set.has(t.id))
    setOpenTabs(remaining)
    setDirtyTabs((d) => {
      const n = new Set(d)
      let changed = false
      for (const id of set) if (n.delete(id)) changed = true
      return changed ? n : d
    })
    if (selected && set.has(selected.id)) {
      const nextActive = remaining[remaining.length - 1] ?? null
      if (nextActive) {
        setSelected(nextActive)
        navigate(`/files/${nextActive.id}`)
      } else {
        setSelected(null)
      }
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

  // 파일을 열면 메인 영역이 편집+프리뷰로 바뀐다 → 트리(사이드바) | 편집 | 프리뷰 3분할(VS Code식)
  const viewerOpen = !!selected && selected.type === 'file' && !trashMode && !favMode

  return (
    <div className="shell">
      <header className="topbar">
        {/* 로고 영역 폭을 사이드바에 맞춰, 검색창 왼쪽이 탭 바 시작선과 정렬되게 한다 */}
        <h2 className="logo" style={{ width: sidebarWidth - 12, flexShrink: 0 }}>
          FileSharer <span className="app-version">{__APP_VERSION__}</span>
        </h2>
        {/* 상단 검색 — 현재 공간에서 파일 이름 + 내용(텍스트)으로 찾고, 누르면 그 파일로 이동 */}
        <div className="topbar-search" ref={searchRef}>
          <span className="topbar-search-icon" aria-hidden>
            🔎
          </span>
          <input
            type="search"
            className="topbar-search-input"
            placeholder="파일 이름·내용 검색"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            value={searchQ}
            onFocus={() => setSearchFocused(true)}
            onChange={(e) => {
              setSearchQ(e.target.value)
              setSearchFocused(true)
            }}
            onKeyDown={(e) => {
              const rows = searchResults ?? []
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setSearchFocused(true)
                setSearchIdx((i) => Math.min(i + 1, rows.length - 1))
              } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                setSearchIdx((i) => Math.max(i - 1, 0))
              } else if (e.key === 'Enter') {
                const pick = rows[searchIdx >= 0 ? searchIdx : 0]
                if (pick) {
                  e.preventDefault()
                  openSearchResult(pick)
                }
              } else if (e.key === 'Escape') {
                setSearchQ('')
                setSearchFocused(false)
                setSearchIdx(-1)
                e.currentTarget.blur()
              }
            }}
            aria-label="파일 이름·내용 검색"
          />
          {searchResults !== null && searchQ.trim() && searchFocused && (
            <div className="topbar-search-results">
              <div className="search-results-head muted">
                {searchResults.length > 0
                  ? `"${searchQ.trim()}" 검색 결과 ${searchResults.length}개`
                  : `"${searchQ.trim()}"에 대한 결과가 없습니다`}
              </div>
              {searchResults.length > 0 && (
                <ul className="search-results-list">
                  {searchResults.map((node, idx) => (
                    <li
                      key={node.id}
                      className={`search-result${idx === searchIdx ? ' active' : ''}`}
                      onMouseEnter={() => setSearchIdx(idx)}
                      onClick={() => openSearchResult(node)}
                    >
                      <span className="node-icon">{node.type === 'folder' ? '📁' : '📄'}</span>
                      <span className="search-result-name">{node.name}</span>
                      {node.match === 'content' && (
                        <span className="search-match-badge" title="내용에서 일치">
                          내용
                        </span>
                      )}
                      <span className="search-result-path muted">
                        {node.path ? node.path : '(루트)'}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
        <div className="topbar-flex-spacer" />
        {/* Stage B: 파일 열었을 때 파일 액션(다운로드·업로드·공유·📋)을 상단 바(이메일 왼쪽)에 */}
        {viewerOpen && selected && (
          <div className="topbar-fileactions">
            <FileActions
              node={selected}
              space={space}
              path={path}
              activeToken={activeToken}
              onActiveToken={setActiveToken}
              onLocalUpload={() => fileInput.current?.click()}
            />
          </div>
        )}
        <div className="topbar-right">
          <span className="muted">{me.email}</span>
          {me.role === 'admin' && (
            <Link to="/admin">
              <button className="btn-utility">관리</button>
            </Link>
          )}
          <button
            className="btn-utility theme-toggle"
            onClick={toggleTheme}
            title={theme === 'dark' ? '라이트 모드로 전환' : '다크 모드로 전환'}
            aria-label="테마 전환"
          >
            {theme === 'dark' ? '☀︎' : '☾'}
          </button>
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

      {/* 파일을 열면(뷰어) LinkBar를 숨긴다 — 경로·다운로드·링크·공유는 에디터 툴바로 통합됨 */}
      {!viewerOpen && (
        <LinkBar
          space={space}
          path={path}
          selected={selected}
          onNavigate={crumbNavigate}
          onDropToCrumb={(id, idx, srcSpace) => {
            if (!spaceId) return
            dropNode(id, { spaceId, folderId: idx === null ? null : path[idx].id }, srcSpace)
          }}
          activeToken={activeToken}
          onActiveToken={setActiveToken}
          onLocalUpload={() => fileInput.current?.click()}
        />
      )}

      <div className="workspace">
        <aside
          className="sidebar"
          style={{ width: sidebarWidth }}
        >
          {/* 상단 아이콘 툴바 — 즐겨찾기(★) · 새로고침 · 새 폴더 · 새 MD (업로드 버튼은 액션 바로 이동) */}
          <div className="sidebar-toolbar">
            <button
              className={`icon-btn sidebar-fav-toggle${favMode ? ' active' : ''}`}
              onClick={toggleFavView}
              title={favMode ? '즐겨찾기 목록 닫기' : '즐겨찾기 보기'}
              aria-label="즐겨찾기"
              aria-pressed={favMode}
            >
              <span className="fav-star-icon" aria-hidden="true">
                {favMode ? '★' : '☆'}
              </span>
            </button>
            <button
              className="icon-btn toolbar-refresh"
              onClick={refreshCurrent}
              disabled={refreshing}
              title="새로고침"
              aria-label="목록 새로고침"
            >
              <IconRefresh className={refreshing ? 'spin' : ''} />
            </button>
            {!trashMode && !favMode && (
              <>
                <button className="icon-btn" onClick={onNewFolder} title="새 폴더" aria-label="새 폴더">
                  <IconFolderPlus />
                </button>
                <button
                  className="icon-btn"
                  onClick={onNewMd}
                  title="새 MD 문서"
                  aria-label="새 MD 문서"
                >
                  <IconFilePlus />
                </button>
              </>
            )}
            {/* 로컬 업로드 파일 선택창 — 버튼은 액션 바('로컬 업로드')로 옮겼고 입력만 항상 유지 */}
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
          </div>
          <div className="sidebar-divider" />
          <div className="sidebar-section-label">공간 · 폴더</div>
          <div className="sidebar-scroll">
          {spaces.map((s) => (
            <div key={s.id}>
              <button
                className={
                  // 휴지통·즐겨찾기·최근 뷰일 땐 공간을 활성 표시하지 않는다(하이라이트 중복 방지)
                  `space-item space-root${
                    s.id === spaceId && !trashMode && !favMode ? ' active' : ''
                  }` + (dragOverSpace === s.id ? ' drag-over' : '')
                }
                onClick={() => switchSpace(s.id)}
                onDragOver={(e) => {
                  const t = e.dataTransfer.types
                  if (t.includes('application/x-node-id') || t.includes('Files')) {
                    e.preventDefault()
                    setDragOverSpace(s.id)
                  }
                }}
                onDragLeave={() => setDragOverSpace((cur) => (cur === s.id ? null : cur))}
                onDrop={(e) => {
                  setDragOverSpace(null)
                  const ids = draggedIds(e)
                  if (ids.length > 0) {
                    e.preventDefault()
                    // 소스 공간과 이 공간이 같으면 이동(이 공간 최상위로), 다르면 복사 — 활성 공간이 아니라 드래그한 파일의 공간으로 판단
                    const srcSpace = e.dataTransfer.getData('application/x-node-space')
                    dropNode(ids[0], { spaceId: s.id, spaceName: s.name }, srcSpace)
                  } else if (e.dataTransfer.types.includes('Files')) {
                    e.preventDefault()
                    // 로컬 파일/폴더 → 이 공간 최상위로 업로드
                    uploadToTarget({ spaceId: s.id, parentId: null }, e)
                  }
                }}
                title={
                  s.id === spaceId
                    ? '항목을 놓으면 이 공간 최상위로 이동 · 로컬 파일을 놓으면 업로드'
                    : `항목을 놓으면 ${s.name}(으)로 복사 · 로컬 파일을 놓으면 업로드`
                }
              >
                {s.name}
              </button>
              {/* 모든 공간의 폴더 트리를 항상 펼쳐 둔다 — 휴지통 모드에서도 사라지지 않게(활성 공간만 하이라이트) */}
              <FolderTree
                  spaceId={s.id}
                  currentFolderId={s.id === spaceId ? currentFolder?.id ?? null : null}
                  selectedFileId={selected?.id ?? null}
                  favIds={favIds}
                  version={treeVersion}
                  onOpenFolder={openFolderById}
                  onOpenFile={openFileFromTree}
                  onDropToFolder={(id, target, ctx) =>
                    dropNode(id, { spaceId: ctx.targetSpaceId, folderId: target }, ctx.srcSpaceId)
                  }
                  onUploadFiles={(folderId, e) =>
                    uploadToTarget({ spaceId: s.id, parentId: folderId }, e)
                  }
                  onRenameCommit={renameCommit}
                  onToggleFavorite={toggleFavFromTree}
                  onDelete={deleteFromTree}
                />
            </div>
          ))}
          </div>
          <div className="sidebar-foot">
            <button
              className={`space-item sidebar-trash${trashMode ? ' active' : ''}${
                dragOverTrash ? ' drag-over' : ''
              }`}
              onClick={() => {
                setTrashMode((t) => !t)
                setFavMode(false)
                setSelected(null)
                // 루트 뷰 진입: URL의 nodeId를 비운다. 안 비우면 폴더 안에서 휴지통을 열고
                // 새로고침할 때 boot()이 URL의 nodeId를 먼저 복원해 이전 폴더로 튄다.
                // path를 함께 비우면 아래 [nodeId] 효과의 currentId===null===nodeId라 모드가 리셋되지 않는다.
                setPath([])
                navigate('/files')
              }}
              onDragOver={(e) => {
                if (e.dataTransfer.types.includes('application/x-node-id')) {
                  e.preventDefault()
                  setDragOverTrash(true)
                }
              }}
              onDragLeave={() => setDragOverTrash(false)}
              onDrop={(e) => {
                const ids = draggedIds(e)
                setDragOverTrash(false)
                if (ids.length === 0) return
                e.preventDefault()
                trashByDrag(ids)
              }}
              title="여기로 끌어다 놓으면 휴지통으로 이동합니다"
            >
              🗑️ 휴지통
            </button>
          </div>
        </aside>

        {/* 사이드바 우측 경계선 — 드래그해 폭 조절(잘린 파일 이름 넓혀 보기) */}
        <div
          className="sidebar-resizer"
          onPointerDown={startSidebarResize}
          title="드래그해서 사이드바 너비 조절"
          role="separator"
          aria-orientation="vertical"
        />

        <div className="content-col">
          {/* 다중 탭 바 — 열린 파일 탭. 활성 하이라이트 · 미저장 ●(호버 시 ✕) · 클릭 전환 · 가운데클릭 닫기 */}
          {openTabs.length > 0 && !trashMode && !favMode && (
            <div className="tab-bar">
              <div
                className="tab-strip"
                role="tablist"
                ref={tabBarRef}
                onWheel={(e) => {
                  // 세로 휠을 탭 스트립 가로 스크롤로 (탭이 넘칠 때만)
                  const el = tabBarRef.current
                  if (el && el.scrollWidth > el.clientWidth) el.scrollLeft += e.deltaY
                }}
                onPointerDown={(e) => {
                  const el = tabBarRef.current
                  if (el) tabDrag.current = { x: e.clientX, scroll: el.scrollLeft, moved: false }
                }}
                onPointerMove={(e) => {
                  const el = tabBarRef.current
                  const d = tabDrag.current
                  if (!el || !d) return
                  if (Math.abs(e.clientX - d.x) > 4) d.moved = true
                  if (d.moved) el.scrollLeft = d.scroll - (e.clientX - d.x)
                }}
                onPointerLeave={() => {
                  tabDrag.current = null
                }}
              >
              {openTabs.map((tab) => {
                const active = viewerOpen && selected?.id === tab.id
                const isDirty = dirtyTabs.has(tab.id)
                return (
                  <div
                    key={tab.id}
                    className={`tab${active ? ' active' : ''}${isDirty ? ' dirty' : ''}`}
                    role="tab"
                    aria-selected={active}
                    title={tab.name}
                    onClick={() => {
                      // 드래그로 스크롤한 경우엔 탭 전환을 억제(다음 pointerdown에서 리셋됨)
                      if (tabDrag.current?.moved) {
                        tabDrag.current = null
                        return
                      }
                      activateTab(tab)
                    }}
                    onAuxClick={(e) => {
                      if (e.button === 1) {
                        e.preventDefault()
                        closeTab(tab.id)
                      }
                    }}
                  >
                    <span className="tab-name">{tab.name}</span>
                    <button
                      className="tab-close"
                      aria-label={`${tab.name} 닫기`}
                      title="닫기"
                      onClick={(e) => {
                        e.stopPropagation()
                        closeTab(tab.id)
                      }}
                    >
                      <span className="tab-close-x">✕</span>
                      <span className="tab-close-dot">●</span>
                    </button>
                  </div>
                )
              })}
              </div>
              {/* Stage B: 탭 줄 오른쪽 — | 칸막이 + (활성 편집기가 portal로 넣는 저장/자동저장) + 삭제 + 닫기 */}
              {viewerOpen && selected && (
                <div className="tab-actions">
                  <span className="tab-actions-divider" aria-hidden="true" />
                  <div className="tab-action-slot" ref={setActionSlot} />
                  <button
                    className="btn-utility btn-danger-ghost"
                    onClick={() => deleteTab(selected)}
                    title="이 파일을 휴지통으로 이동 (복원 가능)"
                  >
                    🗑 삭제
                  </button>
                  <button className="btn-utility" onClick={() => closeTab(selected.id)}>
                    닫기
                  </button>
                </div>
              )}
            </div>
          )}

        {!viewerOpen && (
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
          {/* 알림·업로드 진행이 있을 때만 렌더 — 검색창을 사이드바로 옮긴 뒤 빈 툴바로 생기는 여백 방지 */}
          {(trashMode || favMode || uploads.length > 0 || notice) && (
            <div className="toolbar">
              {trashMode && <span className="muted">휴지통 — 복원하면 원래 위치로 돌아갑니다</span>}
              {favMode && <span className="muted">즐겨찾기 — ★ 를 눌러 해제, 항목을 눌러 이동</span>}
              {uploads.length > 0 && (
                <span className="upload-count muted">
                  업로드 {uploadStats.done}/{uploadStats.total}
                  {uploadStats.failed > 0 && ` · 실패 ${uploadStats.failed}`} · {uploadStats.percent}%
                </span>
              )}
              <span className="toolbar-notice">{notice}</span>
            </div>
          )}

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
          ) : trashMode ? (
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
                {/* 휴지통 전용 '삭제 예정' 열(자동 완전삭제까지 남은 시간) */}
                <th className="col-remaining">삭제 예정</th>
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
              {sortedItems.map((node) => (
                <tr key={node.id}>
                  <td>
                    <span className="node-icon">{node.type === 'folder' ? '📁' : '📄'}</span>{' '}
                    <span className="node-name">{node.name}</span>
                  </td>
                  <td className="col-date muted">
                    {node.uploader && (
                      <span className="by-name" title={`올린 사람: ${node.uploader}`}>
                        {node.uploader}
                      </span>
                    )}
                    {formatDateTime(node.created_at)}
                  </td>
                  <td className="col-remaining">
                    <TrashRemaining purgeAt={node.purge_at} />
                  </td>
                  <td className="col-size muted">
                    {node.type === 'file' ? formatBytes(node.size) : '—'}
                  </td>
                  <td className="col-actions">
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
                  </td>
                </tr>
              ))}
              {sortedItems.length === 0 && (
                <tr>
                  <td colSpan={5} className="empty">
                    휴지통이 비어 있습니다
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          ) : (
            <div className="browser-welcome muted">
              <p>왼쪽 트리에서 파일을 선택해 여세요.</p>
              <p className="browser-welcome-sub">
                추가는 왼쪽 상단 아이콘(＋폴더 · ↑업로드 · ＋MD), 이름 변경·삭제는 항목 우클릭.
              </p>
            </div>
          )}
        </main>
        )}
        {/* 열린 탭을 모두 마운트하고 비활성은 숨김 → 미저장/스크롤/편집잠금 상태 보존 */}
        {openTabs.map((tab) => (
          <div
            key={tab.id}
            className="viewer-area"
            style={{ display: viewerOpen && selected?.id === tab.id ? undefined : 'none' }}
          >
            <ViewerPanel
              node={tab}
              active={viewerOpen && selected?.id === tab.id}
              actionSlot={actionSlot}
              space={space}
              path={path}
              onNavigate={crumbNavigate}
              activeToken={activeToken}
              onActiveToken={setActiveToken}
              onLocalUpload={() => fileInput.current?.click()}
              onDelete={() => deleteTab(tab)}
              onDirtyChange={(d) => setTabDirty(tab.id, d)}
              onNodeUpdated={(fresh) => {
                setOpenTabs((tabs) => tabs.map((t) => (t.id === tab.id ? fresh : t)))
                if (selected?.id === tab.id) setSelected(fresh)
                reload()
              }}
              onClose={() => closeTab(tab.id)}
            />
          </div>
        ))}
        </div>
      </div>
      {uploads.length > 0 && (
        <div className="upload-panel" aria-label="업로드 진행">
          <div className="upload-panel-head muted">
            업로드 {uploadStats.done}/{uploadStats.total}
            {uploadStats.failed > 0 && ` · 실패 ${uploadStats.failed}`} · {uploadStats.percent}%
          </div>
          <ul className="upload-panel-list">
            {uploads
              // 완료된 업로드가 실제 목록에 이미 나타났으면 진행 행을 숨긴다(잔상 방지)
              .filter((u) => !(u.done && items.some((it) => it.name === u.name)))
              .map((u) => (
                <li key={u.id} className={`upload-row${u.error ? ' error' : ''}`}>
                  <span className="node-icon">{u.error ? '⚠️' : '📄'}</span>
                  <span className="node-name">{u.name}</span>
                  <div className="upload-inline-wrap">
                    <progress className="upload-inline-bar" value={u.loaded} max={u.total || 1} />
                    <span className="upload-inline-pct">{u.error ? '실패' : `${percent(u)}%`}</span>
                  </div>
                </li>
              ))}
          </ul>
        </div>
      )}
      {newMdName && (
        <NewMarkdownModal
          name={newMdName}
          onCancel={() => setNewMdName(null)}
          onCreate={createNewMd}
        />
      )}
      {nameModal && (
        <NameModal
          title={nameModal.title}
          initial={nameModal.initial}
          onSubmit={nameModal.onSubmit}
          onClose={() => setNameModal(null)}
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
