import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { Link, useNavigate, useParams } from 'react-router-dom'
import FolderTree from '../components/FolderTree'
import LinkBar from '../components/LinkBar'
import NameModal from '../components/NameModal'
import NewMarkdownModal from '../components/NewMarkdownModal'
import ViewerPanel from '../components/ViewerPanel'
import { api, ApiError, Me, SpaceInfo } from '../lib/api'
import { IconFilePlus, IconFolderPlus, IconRefresh } from '../components/icons'
import { attachDragChip } from '../lib/dragchip'
import { ro } from '../lib/josa'
import { canDo, nextActive, tabsToClose, type TabAction } from '../lib/tabs'
import {
  backTo,
  movedLabel,
  renamedLabel,
  trashedLabel,
  type Previous,
  type Undoable,
} from '../lib/undo'
import { toggleTheme as applyToggle } from '../lib/theme'
import { agoMs, formatAgo, formatBytes, formatDateTime, formatTrashRemaining } from '../lib/format'
import {
  dropUploads,
  markUploadDone,
  partitionBySize,
  runWithConcurrency,
  setProgress,
  statusLabel,
  uploadSummary,
  UploadItem,
} from '../lib/upload'
import {
  addFavorite,
  bundleRequest,
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
  patchNode,
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

interface BackupSummary {
  kind: string
  stamp: string
  created_at: string
  // 규모는 관리자에게만 내려온다(자기가 못 보는 공간의 크기가 드러나므로)
  spaces?: number
  files?: number
  bytes?: number
}

export default function Files() {
  const navigate = useNavigate()
  const { nodeId } = useParams()
  const [me, setMe] = useState<Me | null>(null)
  // 마지막 백업 — "정말 돌고 있나"를 상단에서 한눈에(관리자만).
  const [backup, setBackup] = useState<BackupSummary | null>(null)
  // 'loading' | 'none'(백업 없음) | 'error'(조회 실패) — 배지가 말없이 사라지면
  // "백업이 도는지" 확인하려고 만든 물건이 정작 제 기능을 못 한다.
  const [backupState, setBackupState] = useState<'loading' | 'ok' | 'none' | 'error'>('loading')
  // 버전은 **서버가 말한다**. 번들에 박으면 CDN이 옛 바이트를 내줄 때 거짓말이 된다.
  // 제품 버전(v1.0.0)과 빌드 번호(#151)를 함께 — 전자는 '어디까지 왔나', 후자는 '지금 뭐가 떠 있나'.
  const [version, setVersion] = useState('')
  const [build, setBuild] = useState('')
  const [pr, setPr] = useState('')
  const [builtAt, setBuiltAt] = useState('')
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
  const [searchTyping, setSearchTyping] = useState(false) // true=검색 타이핑 중, false=주소(현재 파일 경로) 표시
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
  // 다중선택: 고른 노드 id + 그게 어느 공간 것인지. 공간마다 트리가 따로 있어서,
  // 공간을 섞어 고르면 '이동이냐 복사냐'가 항목마다 갈린다 — 한 공간 안으로 묶어 둔다.
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [checkedSpace, setCheckedSpace] = useState<string | null>(null)
  const checkedSpaceRef = useRef<string | null>(null) // 같은 배치 안에서도 최신인 사본
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
  // 드래그 중 사이드바 가장자리 근처면 자동 스크롤 — 화면 밖 폴더로 옮길 때 드래그를 멈추지 않아도 된다.
  const sidebarScrollRef = useRef<HTMLDivElement>(null)
  const autoScrollDir = useRef(0) // -1 위로, 1 아래로, 0 정지
  const autoScrollRaf = useRef<number | null>(null)
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
    // 적용·저장은 공용 모듈이 담당한다(공유 페이지와 같은 동작을 쓰기 위해).
    setTheme(applyToggle())
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
    api<{ version?: string; build?: string; pr?: string; built_at?: string }>('/api/health')
      .then((res) => {
        setVersion(res.version || '')
        setBuild(res.build || '')
        setPr(res.pr || '')
        setBuiltAt(res.built_at || '')
      })
      .catch(() => setVersion(''))
  }, [])

  // "내 파일이 언제 백업됐나"는 모두의 관심사다 — 관리자 전용으로 걸어뒀다가 정작
  // 보고 싶어 한 사람이 관리자가 아니어서 안 보였다.
  useEffect(() => {
    if (!me) return
    api<{ enabled: boolean; last: BackupSummary | null; unavailable?: boolean }>(
      '/api/system/backup',
    )
      .then((res) => {
        setBackup(res.last)
        if (!res.enabled) setBackupState('none')
        else if (res.unavailable) setBackupState('error')
        else setBackupState(res.last ? 'ok' : 'none')
      })
      .catch(() => setBackupState('error'))
  }, [me])

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

  // **늦게 온 옛 응답이 새 목록을 덮지 않게 한다.**
  // 파일을 지우면 guard 가 reload 를 한 번 돌리고, 바로 휴지통을 누르면 또 돈다.
  // 둘 중 먼저 보낸 쪽이 늦게 도착하면 휴지통 목록이 일반 목록으로 덮였다 —
  // 방금 지운 파일이 휴지통에 없는 것처럼 보인다(e2e 가 그걸로 간헐 실패했고,
  // 사람이 빠르게 눌러도 똑같이 생긴다).
  const reloadSeq = useRef(0)

  const reload = useCallback(async () => {
    if (!spaceId) return
    const seq = ++reloadSeq.current
    try {
      const list = trashMode
        ? await listTrash(spaceId)
        : currentFolder
          ? await listNodeChildren(currentFolder.id)
          : await listSpaceChildren(spaceId)
      if (seq !== reloadSeq.current) return // 더 최신 요청이 떠 있다 — 이 응답은 버린다
      setItems(list)
    } catch (err) {
      if (seq !== reloadSeq.current) return // 옛 요청의 실패로 새 화면에 경고를 띄우지 않는다
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

  // 탭 우클릭 메뉴 — 어느 탭 위에서, 화면 어디에 떴나.
  // 위치는 **화면 기준(fixed)** 으로 잡는다. 예전에 공유 팝오버를 position:absolute 로
  // 뒀다가, 기준이 되는 조상이 뷰어 열림 여부에 따라 바뀌면서 좌우로 튀었다(v1.0.7).
  const [tabMenu, setTabMenu] = useState<{ id: string; x: number; y: number } | null>(null)
  const tabMenuRef = useRef<HTMLDivElement>(null)

  // **화면 밖으로 나가지 않게 당겨 넣는다.** 포인터 자리에 그대로 띄우면 오른쪽·아래
  // 가장자리에서 메뉴 절반이 잘린다. 크기를 짐작하지 않고 **그려진 뒤 재서** 옮긴다 —
  // 항목 글자가 길어지거나 하나 늘면 짐작은 바로 틀린다.
  useLayoutEffect(() => {
    const el = tabMenuRef.current
    if (!el || !tabMenu) return
    const r = el.getBoundingClientRect()
    const pad = 8
    const x = Math.max(pad, Math.min(tabMenu.x, window.innerWidth - r.width - pad))
    const y = Math.max(pad, Math.min(tabMenu.y, window.innerHeight - r.height - pad))
    if (x !== tabMenu.x || y !== tabMenu.y) setTabMenu({ ...tabMenu, x, y })
  }, [tabMenu])

  /** 여러 탭을 **한 번에** 닫는다.
   *
   * closeTab 을 반복해서 부르면 안 된다 — 매 호출이 그때의 openTabs 를 보고 다음 목록을
   * 만드는데, 그 사이 state 는 아직 안 바뀌어 있어 마지막 호출이 앞의 것을 전부 되살린다.
   *
   * 미저장 확인도 **한 번만** 묻는다. 탭마다 물으면 열 개를 닫을 때 창이 세 번 뜬다.
   */
  function closeTabs(ids: string[]) {
    if (ids.length === 0) return
    const closing = new Set(ids)
    const unsaved = ids.filter((id) => dirtyTabs.has(id))
    if (unsaved.length > 0) {
      const what =
        unsaved.length === 1
          ? `'${openTabs.find((t) => t.id === unsaved[0])?.name ?? ''}'`
          : `${unsaved.length}개`
      if (!window.confirm(`저장하지 않은 변경이 ${what} 있습니다. 그래도 닫을까요?`)) return
    }

    const goTo = selected ? nextActive(openTabs, closing, selected.id) : null
    setOpenTabs((tabs) => tabs.filter((t) => !closing.has(t.id)))
    setDirtyTabs((d) => {
      const n = new Set(d)
      for (const id of ids) n.delete(id)
      return n
    })
    if (selected && closing.has(selected.id)) {
      setSelected(goTo)
      navigate(goTo ? `/files/${goTo.id}` : currentFolder ? `/files/${currentFolder.id}` : '/files')
    }
  }

  function runTabAction(action: TabAction) {
    const id = tabMenu?.id
    setTabMenu(null)
    if (id) closeTabs(tabsToClose(openTabs, id, action))
  }

  // 메뉴는 바깥을 누르거나 Esc 로 닫는다. 창 크기가 바뀌거나 **탭 줄이 스크롤되면**
  // 닫는다 — 메뉴는 그 탭을 가리키고 있는데 탭이 움직이면 가리키는 대상이 어긋난다.
  //
  // **스크롤을 문서 전체(capture)로 듣지 않는다.** 처음엔 그렇게 했는데, 트리나 편집기가
  // 조금만 움직여도 메뉴가 사라졌다 — 게다가 탭을 활성화하면 탭 줄이 그 탭을 보이게
  // 스스로 스크롤하므로, **열자마자 그 스크롤에 닫히는** 일까지 있었다(e2e 가 잡았다).
  // 어긋날 수 있는 건 탭 줄 하나뿐이니 거기만 듣는다.
  useEffect(() => {
    if (!tabMenu) return
    const close = () => setTabMenu(null)
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close()
    const strip = tabBarRef.current // 탭 줄에 이미 달려 있는 ref(휠 가로스크롤이 쓴다)
    window.addEventListener('pointerdown', close)
    window.addEventListener('keydown', onKey)
    window.addEventListener('resize', close)
    strip?.addEventListener('scroll', close)
    return () => {
      window.removeEventListener('pointerdown', close)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', close)
      strip?.removeEventListener('scroll', close)
    }
  }, [tabMenu])

  // 외부/동시 삭제(다른 세션·API·e2e reset)로 노드가 사라진 걸 편집기가 감지하면 호출된다.
  // 미저장이 아니면 탭을 조용히 닫아(삭제된 노드로 하트비트가 계속 404를 쏘지 않게) 목록·트리도 갱신.
  // 미저장이면 사용자가 내용을 지킬 수 있게 탭은 남긴다(편집기가 '삭제됨' 배너 + 하트비트 중단 처리).
  function handleTabDeleted(id: string) {
    if (dirtyTabs.has(id)) return
    closeTab(id, true) // force=true: 미저장 확인창 없이(어차피 미저장 아님)
    reload()
    setTreeVersion((v) => v + 1) // 사이드바 트리에서도 사라졌을 수 있음
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
        setSearchTyping(false) // 바깥 클릭 = 검색 포기 → 주소(경로) 모드로 복귀
        setSearchQ('')
      }
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [searchFocused])

  // 드래그가 어디서 끝나든(바깥에 놓거나 Esc로 취소해도) 사이드바 자동 스크롤을 멈춘다.
  useEffect(() => {
    const stop = () => {
      autoScrollDir.current = 0
    }
    window.addEventListener('dragend', stop)
    window.addEventListener('drop', stop)
    return () => {
      window.removeEventListener('dragend', stop)
      window.removeEventListener('drop', stop)
    }
  }, [])

  // 파일을 열거나 다른 파일로 바뀌면 주소창을 '경로 모드'로 되돌린다(진행 중이던 검색어는 비운다).
  useEffect(() => {
    const fileOpen = !!selected && selected.type === 'file' && !trashMode && !favMode
    if (fileOpen) {
      setSearchTyping(false)
      setSearchQ('')
      setSearchIdx(-1)
    }
    // selected.id만 추적(같은 파일 객체 교체마다 재실행 방지)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id, trashMode, favMode])

  // 검색 결과 선택 → 그 파일을 열고 검색을 닫는다(클릭·Enter 공통)
  function openSearchResult(node: NodeInfo) {
    openLocated(node)
    setSearchQ('')
    setSearchTyping(false) // 주소(경로) 모드로 복귀 — 연 파일의 경로가 검색창에 뜬다
    setSearchFocused(false)
    setSearchIdx(-1)
  }

  // ── 되돌리기(직전 한 번만) ──
  // **왜 배너가 필요한가**: 드래그로 여러 개를 엉뚱한 폴더에 떨어뜨리면, 지금은 어디서
  // 왔는지 아무도 기억하지 않는다. 하나씩 더듬어 되돌리는 수밖에 없었다.
  // 배너는 되돌리는 길이기도 하지만 **방금 무슨 일이 있었는지 말해주는 자리**이기도 하다.
  const [undoable, setUndoable] = useState<Undoable | null>(null)
  const undoTimer = useRef<number | null>(null)
  // 위 ⌘Z 리스너는 한 번만 달리므로(의존성 []), state 를 바로 읽으면 영원히 null 이다.
  const undoableRef = useRef<Undoable | null>(null)
  undoableRef.current = undoable

  function offerUndo(entry: Undoable) {
    if (undoTimer.current) window.clearTimeout(undoTimer.current)
    setUndoable(entry)
    // 12초. 너무 짧으면 '어?' 하는 사이에 사라지고, 계속 떠 있으면 한참 전 작업을
    // 되돌려 더 놀라게 된다.
    undoTimer.current = window.setTimeout(() => setUndoable(null), 12_000)
  }

  function dismissUndo() {
    if (undoTimer.current) window.clearTimeout(undoTimer.current)
    setUndoable(null)
  }

  async function runUndo() {
    const entry = undoableRef.current
    if (!entry) return
    dismissUndo() // 두 번 눌러 두 번 돌아가지 않게 **먼저** 치운다
    try {
      await entry.run()
      flash('되돌렸습니다')
    } catch (err) {
      flash(err instanceof Error ? err.message : '되돌리지 못했습니다')
    } finally {
      reload()
      setTreeVersion((v) => v + 1)
    }
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

  // 여러 항목을 휴지통으로(드래그 드롭·다중선택 둘 다 여기로 온다).
  // 드래그로 놓은 경우엔 확인창이 없다 — 복원할 수 있으므로.
  async function trashMany(ids: string[]) {
    if (ids.length === 0) return
    // 지우기 **전에** 이름을 집어둔다 — 지우고 나면 목록에서 사라져 뭘 지웠는지 말할 수 없다.
    const names = ids.map((id) => items.find((n) => n.id === id)?.name).filter((n): n is string => !!n)
    try {
      for (const id of ids) await deleteNode(id)
      offerUndo({
        label: trashedLabel(names, ids.length),
        run: async () => {
          for (const id of ids) await restoreNode(id)
        },
      })
    } catch (err) {
      flash(err instanceof Error ? err.message : '삭제에 실패했습니다')
    } finally {
      closeViewerIfAffected(ids)
      reload()
      setTreeVersion((v) => v + 1)
    }
  }

  // ── 다중선택 ──
  function clearChecked() {
    checkedSpaceRef.current = null
    setChecked((c) => (c.size > 0 ? new Set() : c))
    setCheckedSpace(null)
  }
  // 트리가 준 갱신 함수를 **이전 값에 적용**한다 — 통째로 받으면 연달아 빠르게 누를 때
  // 리렌더 전의 옛 선택을 덮어써 클릭 하나가 먹힌다.
  // 다른 공간에서 고르기 시작하면 이전 선택은 버린다(이동/복사 판단이 항목마다 갈리므로).
  // 그 판단은 ref로 한다 — 같은 배치 안의 두 번째 클릭에게는 state가 아직 옛 공간이다.
  // 고른 것 안의 폴더 수(트리가 세어 올려준다). 폴더를 고르면 그 안의 파일도 함께
  // 처리되는데 개수만 봐서는 안 보인다 — 하단 바와 삭제 확인창이 그 사실을 말한다.
  const [checkedFolders, setCheckedFolders] = useState(0)

  function applyChecked(ofSpace: string, update: (prev: Set<string>) => Set<string>) {
    const fresh = checkedSpaceRef.current !== ofSpace
    checkedSpaceRef.current = ofSpace
    setCheckedSpace(ofSpace)
    setChecked((prev) => update(fresh ? new Set() : prev))
  }
  async function bulkDelete(ids: string[]) {
    if (ids.length === 0) return
    // 폴더가 끼어 있으면 화면 숫자보다 많이 사라진다 — 지우기 전에 말해준다.
    const inside =
      checkedFolders > 0
        ? `\n\n폴더 ${checkedFolders}개가 들어 있습니다 — 그 안의 파일도 함께 사라집니다.`
        : ''
    if (!window.confirm(`${ids.length}개를 휴지통으로 이동할까요?${inside}`)) return
    clearChecked()
    await trashMany(ids)
  }
  function bulkDownload(ids: string[]) {
    const req = bundleRequest(ids)
    if ('error' in req) {
      flash(req.error)
      return
    }
    // 숨은 iframe 으로 받는다. location.href 로 보내면 서버가 에러를 줄 때 브라우저가 그
    // JSON 페이지로 화면을 통째로 옮겨 버려 하던 일을 잃는다.
    // 성공하면(Content-Disposition: attachment) iframe 은 load 되지 않고 받기만 시작된다 —
    // load 가 떴다는 건 '문서가 그려졌다', 곧 뭔가 잘못됐다는 뜻이다.
    const frame = document.createElement('iframe')
    frame.hidden = true
    frame.src = req.url
    frame.onload = () => {
      flash('내려받지 못했습니다')
      frame.remove()
    }
    document.body.appendChild(frame)
    // 성공했을 땐 load 가 안 뜨므로 시간을 두고 치운다(큰 묶음은 만드는 데 오래 걸린다)
    window.setTimeout(() => frame.remove(), 10 * 60_000)
  }

  // ⌘Z — **선택과 무관하게** 듣는다. 아래 Esc·Delete 리스너는 고른 게 있을 때만 붙는데,
  // 되돌릴 일(이동·삭제)은 끝나면서 선택을 비우므로 거기 얹으면 영영 안 먹는다.
  // 글자를 치는 중이나 에디터 안에서는 가로채지 않는다 — 거기선 ⌘Z 가 글자 되돌리기다.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z')) return
      const el = e.target as HTMLElement | null
      if (el?.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el?.tagName ?? '')) return
      if (el?.closest('.editor-shell')) return
      if (!undoableRef.current) return
      e.preventDefault()
      void runUndo()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Esc=선택 해제, Delete/Backspace=고른 것 삭제. 글자를 치는 중에는 가로채지 않는다.
  useEffect(() => {
    if (checked.size === 0) return
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null
      if (el?.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el?.tagName ?? '')) return
      if (e.key === 'Escape') clearChecked()
      else if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault()
        void bulkDelete([...checked])
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // 의존성 배열이 없는 건 일부러다. 삭제는 열린 탭(openTabs)까지 정리하는데, 배열을
    // [checked]로 좁히면 그 사이 탭이 바뀌어도 옛 목록을 들고 지우게 된다. 리스너 하나를
    // 매 렌더 다시 다는 비용이 그 버그보다 싸다.
  })

  // 휴지통·즐겨찾기로 넘어가면 트리 선택은 의미를 잃는다 — 그 화면의 대상이 아니다.
  useEffect(() => {
    if (trashMode || favMode) {
      checkedSpaceRef.current = null
      setChecked((c) => (c.size > 0 ? new Set() : c))
      setCheckedSpace(null)
    }
  }, [trashMode, favMode])

  // ── 사이드바 트리의 행에서 바로 하는 것들(이름 변경 · 즐겨찾기 · 삭제) ──
  // 인라인 이름변경 커밋(빈/동일 이름 무시는 FolderTree 쪽에서 처리) — guard가 reload + treeVersion 갱신.
  // 백엔드가 돌려준 실제 새 이름(중복 시 "(2)" 포함)으로, 열린 탭·선택 파일·주소창 경로를 함께 갱신한다.
  async function renameCommit(row: TreeRow, name: string) {
    const fresh = await guard(() => renameNode(row.id, name))
    if (!fresh) return
    if (fresh.previous.name !== fresh.name) {
      offerUndo({
        label: renamedLabel(fresh.previous.name, fresh.name),
        run: async () => {
          await patchNode(fresh.id, { name: fresh.previous.name })
        },
      })
    }
    setOpenTabs((tabs) => tabs.map((t) => (t.id === fresh.id ? { ...t, name: fresh.name } : t)))
    setSelected((sel) => (sel?.id === fresh.id ? { ...sel, name: fresh.name } : sel))
    setPath((p) => p.map((f) => (f.id === fresh.id ? { ...f, name: fresh.name } : f)))
  }
  async function deleteFromTree(row: TreeRow) {
    if (!window.confirm(`"${row.name}"을(를) 휴지통으로 이동할까요?`)) return
    await guard(() => deleteNode(row.id))
    offerUndo({
      label: trashedLabel([row.name], 1),
      run: async () => {
        await restoreNode(row.id)
      },
    })
    closeTab(row.id, true) // 열려 있던 탭이면 닫기(활성이면 이웃으로 이동)
  }
  // 뷰어 액션 바의 🗑 삭제 — 그 파일을 휴지통으로 이동하고 해당 탭을 닫는다.
  async function deleteTab(node: NodeInfo) {
    if (!window.confirm(`"${node.name}"을(를) 휴지통으로 이동할까요?`)) return
    await guard(() => deleteNode(node.id))
    offerUndo({
      label: trashedLabel([node.name], 1),
      run: async () => {
        await restoreNode(node.id)
      },
    })
    closeTab(node.id, true)
  }
  function toggleFavFromTree(row: TreeRow) {
    // toggleFav는 node.id만 사용 — TreeRow에 NodeInfo 필수 필드만 채워 넘긴다
    toggleFav({ ...row, space_id: spaceId ?? '', created_at: null, updated_at: null })
  }

  // 드래그 항목을 폴더/공간에 놓았을 때: 같은 공간이면 이동, 다른 공간이면 복사(원본 유지).
  // 판단 기준은 "드래그한 파일의 실제 공간(srcSpaceId) vs 놓은 대상의 공간" — 활성 공간이 아니다.
  // (두 공간 트리를 동시에 보여준 뒤로, 활성 공간 기준 판단은 크로스공간 드롭을 이동으로 오판했다.)
  // 여러 개를 한 번에 놓을 수 있다(다중선택). 항목마다 guard()를 부르면 N번 새로 읽게 되므로
  // 여기서 직접 돌리고 **끝나고 한 번만** 갱신한다.
  async function dropNodes(
    draggedIdList: string[],
    target: { spaceId: string; folderId?: string | null; spaceName?: string },
    srcSpaceId?: string,
  ) {
    const folderId = target.folderId ?? null
    const ids = draggedIdList.filter((id) => id !== folderId) // 자기 자신 위에 놓은 건 무시
    if (ids.length === 0) return
    const copying = !!srcSpaceId && srcSpaceId !== target.spaceId
    const where = folderId ? { parentId: folderId } : { spaceId: target.spaceId }
    let done = 0
    // 옮긴 항목마다 '바뀌기 전'을 모은다 — 되돌릴 때 **항목별로 제자리**로 보내야 한다.
    // 한 번에 끌었다고 다 같은 폴더에서 온 건 아니다(검색 결과에서 고르면 제각각이다).
    const moved: { id: string; previous: Previous }[] = []
    try {
      for (const id of ids) {
        // 분기를 삼항으로 합치면 두 반환형의 합집합이 되어 previous 를 못 읽는다.
        if (copying) {
          await copyNode(id, where)
        } else {
          const res = await moveNode(id, where)
          moved.push({ id, previous: res.previous })
        }
        done += 1
      }
      if (!copying && moved.length > 0) {
        offerUndo({
          label: movedLabel(
            moved.map((m) => m.previous.name),
            target.spaceName ?? null,
          ),
          run: async () => {
            for (const m of moved) await patchNode(m.id, backTo(m.previous))
          },
        })
      }
      if (copying && done > 0) {
        const many = done > 1 ? `${done}개를 ` : ''
        flash(
          target.spaceName
            ? `${many}${target.spaceName}${ro(target.spaceName)} 복사했습니다`
            : '복사했습니다',
        )
      }
    } catch (err) {
      flash(err instanceof Error ? err.message : '요청에 실패했습니다')
    } finally {
      if (!copying) closeViewerIfAffected(ids) // 열려 있던 파일을 옮겼으면 뷰어를 닫는다
      clearChecked()
      reload()
      setTreeVersion((v) => v + 1) // 폴더 구조 변경 반영 → 사이드바 트리 갱신
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

  // ── 드래그 중 사이드바 자동 스크롤 ──
  // 가장자리 근처에 커서가 오면 그 방향으로 계속 스크롤한다(rAF라 프레임에 맞춰 부드럽게).
  // 없으면 화면 밖 폴더로 옮길 때 드래그를 멈추고 수동으로 스크롤해야 한다.
  function autoScrollStep() {
    const el = sidebarScrollRef.current
    if (!el || autoScrollDir.current === 0) {
      autoScrollRaf.current = null
      return
    }
    el.scrollTop += autoScrollDir.current * 10
    autoScrollRaf.current = requestAnimationFrame(autoScrollStep)
  }
  function onSidebarDragOver(e: React.DragEvent) {
    const el = sidebarScrollRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const EDGE = 44 // 가장자리 감지 폭(px)
    autoScrollDir.current = e.clientY < r.top + EDGE ? -1 : e.clientY > r.bottom - EDGE ? 1 : 0
    if (autoScrollDir.current !== 0 && autoScrollRaf.current === null) {
      autoScrollRaf.current = requestAnimationFrame(autoScrollStep)
    }
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
  // 오미니박스: 파일을 열면 상단 검색창이 '주소창'이 되어 그 파일의 읽기 좋은 경로를 보여준다.
  // 타이핑을 시작하면(searchTyping) 검색 모드로 전환, 결과를 고르면 다시 주소(경로) 모드로 돌아온다.
  const filePath =
    viewerOpen && selected
      ? [space?.name, ...path.map((p) => p.name), selected.name].filter(Boolean).join('/')
      : ''
  const addressMode = viewerOpen && !searchTyping // true=경로 표시(드롭다운 숨김), false=검색 모드

  // 기본이 주 1회라 8일이 넘으면 어딘가 멈춘 것이다(배포 실패·권한 만료 등) → 눈에 띄게.
  const backupStale = (agoMs(backup?.created_at) ?? 0) > 8 * 86_400_000

  return (
    <div className="shell">
      <header className="topbar">
        {/* 로고 영역 폭을 사이드바에 맞춰, 검색창 왼쪽이 탭 바 시작선과 정렬되게 한다 */}
        <h2 className="logo" style={{ minWidth: sidebarWidth - 12, flexShrink: 0 }}>
          FileSharer{' '}
          <span
            className="app-version"
            title={
              build
                ? `${version} · 빌드 ${build}${pr ? ` (${pr})` : ''}` +
                  (builtAt ? ` · ${formatDateTime(builtAt)} 배포` : '')
                : '서버가 보고하는 버전'
            }
          >
            {version || '…'}
          </span>
          {backupState !== 'loading' && (
            <span
              className={`backup-badge${backupStale || backupState !== 'ok' ? ' is-stale' : ''}`}
              title={
                backup
                  ? `마지막 백업 ${formatDateTime(backup.created_at)}` +
                    ` · ${backup.kind === 'weekly' ? '주간' : '월간'} ${backup.stamp}` +
                    (backup.files != null
                      ? ` · 공간 ${backup.spaces}개 · 파일 ${backup.files}개` +
                        ` · ${formatBytes(backup.bytes ?? 0)}`
                      : '') +
                    (backupStale ? ' — 주기(주 1회)보다 오래됐습니다' : '')
                  : backupState === 'error'
                    ? '백업 상태를 읽지 못했습니다 — 저장소 접근을 확인하세요'
                    : '아직 백업이 없습니다'
              }
            >
              {backup
                ? `⛁ ${formatAgo(backup.created_at)}`
                : backupState === 'error'
                  ? '⛁ 확인 불가'
                  : '⛁ 없음'}
            </span>
          )}
        </h2>
        {/* 상단 검색 = 주소창(오미니박스). 파일을 열면 그 파일의 경로를 보여주고(주소 모드),
            타이핑하면 이름+내용 검색(검색 모드).
            사내 링크 복사는 **공유 팝오버 안('사내' 칸)** 으로 옮겼다 — 한 파일을 남에게 주는
            방법이 주소창과 팝오버 두 군데로 흩어져 있었다. */}
        <div className={`topbar-search${addressMode ? ' is-address' : ''}`} ref={searchRef}>
          <span className="topbar-search-icon" aria-hidden>
            {addressMode ? '📄' : '🔎'}
          </span>
          <input
            type="search"
            className="topbar-search-input"
            placeholder="파일 이름·내용 검색"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            value={addressMode ? filePath : searchQ}
            title={addressMode ? filePath : undefined}
            onFocus={(e) => {
              setSearchFocused(true)
              if (addressMode) e.currentTarget.select() // 경로 전체 선택 → 타이핑하면 바로 검색으로 대체
            }}
            onMouseUp={(e) => {
              // 주소 모드에서 클릭이 커서를 옮겨 전체선택을 풀면 타이핑이 경로 뒤에 붙어 검색이 안 된다.
              // 마우스업 기본동작을 막아 onFocus의 전체선택을 유지 → 타이핑하면 경로를 통째로 대체.
              if (addressMode) e.preventDefault()
            }}
            onChange={(e) => {
              setSearchTyping(true) // 타이핑 시작 = 검색 모드
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
                setSearchTyping(false) // 주소(경로) 모드로 복귀
                setSearchFocused(false)
                setSearchIdx(-1)
                e.currentTarget.blur()
              }
            }}
            aria-label="파일 경로·검색 주소창"
          />
          {searchTyping && searchResults !== null && searchQ.trim() && searchFocused && (
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
        {/* 파일 액션(다운로드·로컬/서버 업로드·공유)은 **탭 줄**로 내렸다(아래 .tab-actions).
            상단 가운데에 있으면 늘 같은 자리에 같은 모양으로 떠 있어서 "열린 파일에 대한
            버튼"처럼 보이는데, 실제로는 대상이 섞여 있다(다운로드·공유는 고른 것, 업로드·서버는
            지금 있는 곳). 시연에서 그 지적을 받았다. */}
        <div className="topbar-right">
          <span className="muted">{me.email}</span>
          {/* CLI 안내는 서버 전송 팝오버 안에만 링크돼 있어 찾기 어려웠다(사용자가 못 찾았다).
              관리처럼 '가끔 쓰지만 있는 줄은 알아야 하는' 페이지라 여기 둔다 — 다만
              관리와 달리 **모두에게** 보인다. 설치 방법을 알아야 할 사람이 관리자만은 아니다. */}
          <Link to="/cli">
            <button className="btn-utility" title="브라우저 없이 쓰기 — 설치·로그인·명령">
              CLI
            </button>
          </Link>
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
          <div
            className="sidebar-scroll"
            ref={sidebarScrollRef}
            onDragOver={onSidebarDragOver}
            onDragLeave={() => {
              autoScrollDir.current = 0
            }}
          >
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
                  if (
                    t.includes('application/x-node-id') ||
                    t.includes('application/x-trash-node-id') ||
                    t.includes('Files')
                  ) {
                    e.preventDefault()
                    setDragOverSpace(s.id)
                  }
                }}
                onDragLeave={() => setDragOverSpace((cur) => (cur === s.id ? null : cur))}
                onDrop={(e) => {
                  setDragOverSpace(null)
                  // 휴지통 항목을 공간 위에 놓으면 원래 위치로 복원(어느 공간에 놓든 restoreNode가 원위치로)
                  const trashId = e.dataTransfer.getData('application/x-trash-node-id')
                  if (trashId) {
                    e.preventDefault()
                    void guard(() => restoreNode(trashId)).then((r) => r && flash('복원했습니다'))
                    return
                  }
                  const ids = draggedIds(e)
                  if (ids.length > 0) {
                    e.preventDefault()
                    // 소스 공간과 이 공간이 같으면 이동(이 공간 최상위로), 다르면 복사 — 활성 공간이 아니라 드래그한 파일의 공간으로 판단
                    const srcSpace = e.dataTransfer.getData('application/x-node-space')
                    dropNodes(ids, { spaceId: s.id, spaceName: s.name }, srcSpace)
                  } else if (e.dataTransfer.types.includes('Files')) {
                    e.preventDefault()
                    // 로컬 파일/폴더 → 이 공간 최상위로 업로드
                    uploadToTarget({ spaceId: s.id, parentId: null }, e)
                  }
                }}
                // 휴지통 모드에서 끌면 **어느 공간에 놓든 원래 자리로 복원**된다(restoreNode).
                // 그런데 문구는 "이 공간으로 복사"라고 말하고 있었다 — 사실과 다르다.
                title={
                  trashMode
                    ? '휴지통 항목을 놓으면 원래 위치로 복원됩니다 (이 공간으로 옮기는 게 아닙니다)'
                    : s.id === spaceId
                      ? '항목을 놓으면 이 공간 최상위로 이동 · 로컬 파일을 놓으면 업로드'
                      : `항목을 놓으면 ${s.name}${ro(s.name)} 복사 · 로컬 파일을 놓으면 업로드`
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
                  onDropToFolder={(ids, target, ctx) =>
                    dropNodes(
                      ids,
                      {
                        spaceId: ctx.targetSpaceId,
                        folderId: target,
                        spaceName: ctx.targetName ?? s.name,
                      },
                      ctx.srcSpaceId,
                    )
                  }
                  onUploadFiles={(folderId, e) =>
                    uploadToTarget({ spaceId: s.id, parentId: folderId }, e)
                  }
                  onRenameCommit={renameCommit}
                  onToggleFavorite={toggleFavFromTree}
                  onDelete={deleteFromTree}
                  // 선택은 한 공간 안에서만 — 다른 공간 트리에는 넘기지 않는다
                  checked={checkedSpace === s.id ? checked : undefined}
                  onChecked={applyChecked}
                  onFolderCount={setCheckedFolders}
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
                clearChecked()
                trashMany(ids)
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
          {/* 다중 탭 바 — 열린 파일 탭. 활성 하이라이트 · 미저장 ●(호버 시 ✕) · 클릭 전환 · 가운데클릭 닫기
              **탭이 하나도 없어도 이 줄은 뜬다.** 액션 네 개 중 '로컬 업로드'와 '서버'는 열린 파일이
              아니라 **지금 보고 있는 폴더**가 대상이라, 탭에 묶어 두면 로그인 직후엔 업로드할 방법이
              아예 없어진다(끌어다 놓기 말고는). 탭 쪽 컨트롤(저장·삭제·닫기)만 탭이 있을 때 붙인다. */}
          {!trashMode && !favMode && (
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
                    onContextMenu={(e) => {
                      e.preventDefault() // 브라우저 기본 메뉴 대신 우리 것
                      setTabMenu({ id: tab.id, x: e.clientX, y: e.clientY })
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
              {/* 탭 우클릭 메뉴. 탭마다 ✕ 가 있고 가운데클릭으로도 닫히지만, **여러 개를
                  한꺼번에** 닫을 길이 없었다 — 열 개를 열어두면 ✕ 를 열 번 눌러야 했다.
                  (트리 행의 우클릭 메뉴는 예전에 없앴는데, 그건 같은 일을 행에서 바로
                  할 수 있어서였다. 여기는 그 대안이 아예 없다.) */}
              {tabMenu && (
                <div
                  className="tab-menu"
                  ref={tabMenuRef}
                  role="menu"
                  aria-label="탭"
                  style={{ left: tabMenu.x, top: tabMenu.y }}
                  // 메뉴 안을 누르는 건 '바깥 클릭' 이 아니다 — 안 막으면 항목을 누르는
                  // 순간 메뉴가 먼저 닫혀 클릭이 허공에 떨어진다.
                  onPointerDown={(e) => e.stopPropagation()}
                >
                  {(
                    [
                      ['this', '닫기'],
                      ['others', '다른 탭 모두 닫기'],
                      ['all', '모두 닫기'],
                    ] as [TabAction, string][]
                  ).map(([action, label]) => (
                    <button
                      key={action}
                      role="menuitem"
                      className="tab-menu-item"
                      // 누를 수 없는 항목도 **지우지 않고 흐리게** 둔다. 메뉴 모양이
                      // 상황마다 달라지면 같은 자리에 다른 것이 와서 잘못 누르게 된다.
                      disabled={!canDo(openTabs, tabMenu.id, action)}
                      onClick={() => runTabAction(action)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              )}

              {/* Stage B: 탭 줄 오른쪽 — 파일 액션 + | 칸막이 + (활성 편집기가 portal로 넣는 저장/자동저장) + 삭제 + 닫기 */}
              <div className="tab-actions">
                {/* 파일 액션 — 자동저장·저장 **왼쪽**. 삭제·닫기와 한 줄에 모여 있어야
                    "지금 열어 둔 이것에 대한 버튼"으로 읽힌다.
                    탭이 없을 땐 이 네 개만 남는다 — 다운로드·공유는 고른 게 없으면 스스로 빠지거나
                    눌리지 않고, 업로드·서버는 지금 폴더를 대상으로 그대로 동작한다. */}
                {space && (
                  <LinkBar
                    actionsOnly
                    space={space}
                    path={path}
                    selected={selected}
                    activeToken={activeToken}
                    onActiveToken={setActiveToken}
                    onLocalUpload={() => fileInput.current?.click()}
                  />
                )}
                {viewerOpen && selected && (
                  <>
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
                  </>
                )}
              </div>
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
                <tr
                  key={node.id}
                  draggable
                  onDragStart={(e) => {
                    // 휴지통 항목을 공간 위로 끌어다 놓으면 복원 — 공간 드롭 핸들러가 읽는 마커
                    e.dataTransfer.setData('application/x-trash-node-id', node.id)
                    e.dataTransfer.effectAllowed = 'move'
                    // 트리와 같은 칩을 쓴다. 예전엔 여기만 기본 고스트여서 휴지통에서
                    // 끌 때만 큰 반투명 행이 따라붙었다 — 같은 동작은 같아 보여야 한다.
                    attachDragChip(e, { count: 1, name: node.name, type: node.type })
                  }}
                  title="공간으로 끌어다 놓으면 원래 위치로 복원됩니다"
                >
                  <td>
                    <span className="node-icon">{node.type === 'folder' ? '📁' : '📄'}</span>{' '}
                    <span className="node-name">{node.name}</span>
                  </td>
                  {/* 날짜를 앞에 둔다 — 이 열은 날짜로 정렬되는데 이름이 앞에 있으면
                      정렬된 것처럼 보이지 않는다(눈이 첫 글자를 먼저 읽는다). */}
                  <td className="col-date muted">
                    {formatDateTime(node.created_at)}
                    {node.uploader && (
                      <span className="by-name" title={`올린 사람: ${node.uploader}`}>
                        {node.uploader}
                      </span>
                    )}
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
                새로 만들기는 왼쪽 상단 아이콘(＋폴더 · ＋MD), 올리기는 위 줄의 ↑ 아이콘(또는 창에
                끌어다 놓기). 이름 변경은 항목을 고르고 Enter, 즐겨찾기·삭제는 행의 ★·🗑.
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
              onDeleted={handleTabDeleted}
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
      {/* 둘 이상일 때만 띄운다. 이제 파일을 그냥 클릭해도 그 하나가 '선택된' 상태가
          되므로(FolderTree 의 activateRow 참고), 0개 초과로 두면 파일을 열 때마다
          바가 따라 올라와 화면을 가린다. 하나짜리 작업은 행의 ★·🗑 로 한다. */}
      {/* 되돌리기 띠 — 방금 무슨 일이 있었는지 말하고, 한 번에 물린다.
          고른 게 있어 하단 바가 떠 있으면 그 위로 올라간다(겹치면 둘 다 못 읽는다). */}
      {undoable && (
        <div
          className={`undo-bar${checked.size > 1 ? ' is-stacked' : ''}`}
          role="status"
          aria-label="되돌리기"
        >
          <span className="undo-bar-text">{undoable.label}</span>
          <button className="btn-utility undo-bar-go" onClick={() => void runUndo()}>
            되돌리기
          </button>
          <button
            className="icon-btn undo-bar-close"
            aria-label="닫기"
            onClick={dismissUndo}
          >
            ✕
          </button>
        </div>
      )}
      {checked.size > 1 && (
        <div className="bulk-bar" role="status" aria-label="선택 항목">
          <strong>{checked.size}개 선택됨</strong>
          {checkedFolders > 0 && (
            <span className="bulk-bar-warn">
              폴더 {checkedFolders}개 포함 — 안의 파일도 함께 처리됩니다
            </span>
          )}
          <span className="muted bulk-bar-hint">
            Ctrl/⌘+클릭으로 더 고르기 · Shift+클릭으로 범위 · 폴더나 공간으로 끌면 이동·복사
          </span>
          <div className="bulk-bar-actions">
            <button className="btn-utility" onClick={() => bulkDownload([...checked])}>
              ⤓ 내려받기
            </button>
            <button className="btn-utility danger" onClick={() => void bulkDelete([...checked])}>
              🗑 삭제
            </button>
            <button className="btn-utility" onClick={clearChecked}>
              선택 해제
            </button>
          </div>
        </div>
      )}
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
                    {/* 퍼센트가 아니라 **지금 무슨 일이 벌어지는지**를 적는다.
                        바가 꽉 찼는데 숫자가 안 오르면 멈춘 것처럼 보인다 — 그 사이
                        서버가 저장·체크섬·색인을 하고 있다(lib/upload.ts 의 isSaving). */}
                    <span className="upload-inline-pct">{statusLabel(u)}</span>
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
