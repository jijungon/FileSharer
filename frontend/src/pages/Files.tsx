import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import LinkBar from '../components/LinkBar'
import { api, ApiError, Me, SpaceInfo } from '../lib/api'
import { downloadUrlData, supportsDragOut } from '../lib/dragout'
import { formatBytes } from '../lib/format'
import {
  createFolder,
  deleteNode,
  downloadUrl,
  getNodePath,
  listNodeChildren,
  listSpaceChildren,
  listTrash,
  moveNode,
  NodeInfo,
  renameNode,
  restoreNode,
  uploadFile,
} from '../lib/files'

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
  const [dropActive, setDropActive] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const restoredFromUrl = useRef(false)

  const space = spaces.find((s) => s.id === spaceId) ?? null
  const currentFolder = path.length > 0 ? path[path.length - 1] : null

  // 초기 로드: me + spaces (+ 딥링크 복원)
  useEffect(() => {
    async function boot() {
      try {
        const [meRes, spacesRes] = await Promise.all([
          api<Me>('/api/me'),
          api<SpaceInfo[]>('/api/spaces'),
        ])
        setMe(meRes)
        setSpaces(spacesRes)
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
            return
          } catch {
            setNotice('링크의 항목을 찾을 수 없습니다')
          }
        }
        setSpaceId((prev) => prev ?? spacesRes[0]?.id ?? null)
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) navigate('/login', { replace: true })
      }
    }
    boot()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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
    }
  }

  async function onNewFolder() {
    const name = window.prompt('새 폴더 이름')
    if (!name || !spaceId) return
    await guard(() => createFolder(spaceId, currentFolder?.id ?? null, name))
  }

  async function uploadAll(files: FileList | File[]) {
    if (!spaceId) return
    for (const file of Array.from(files)) {
      await guard(() => uploadFile({ spaceId, parentId: currentFolder?.id ?? null }, file))
    }
    flash('업로드 완료')
  }

  async function onRename(node: NodeInfo) {
    const name = window.prompt('새 이름', node.name)
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

  function rowDragStart(e: React.DragEvent, node: NodeInfo) {
    e.dataTransfer.setData('application/x-node-id', node.id)
    if (supportsDragOut()) {
      e.dataTransfer.setData('DownloadURL', downloadUrlData(node, window.location.origin))
    }
    e.dataTransfer.effectAllowed = 'copyMove'
  }

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

      <div className="workspace">
        <aside className="sidebar">
          {spaces.map((s) => (
            <button
              key={s.id}
              className={`space-item${s.id === spaceId ? ' active' : ''}`}
              onClick={() => switchSpace(s.id)}
            >
              {s.type === 'personal' ? '🔒' : s.type === 'team' ? '👥' : '🏢'} {s.name}
            </button>
          ))}
          <div className="sidebar-foot">
            <button
              className={`space-item${trashMode ? ' active' : ''}`}
              onClick={() => {
                setTrashMode((t) => !t)
                setSelected(null)
              }}
            >
              🗑 휴지통
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
            if (e.dataTransfer.files.length > 0) {
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
              </>
            )}
            {trashMode && <span className="muted">휴지통 — 복원하면 원래 위치로 돌아갑니다</span>}
            <span className="toolbar-notice">{notice}</span>
          </div>

          <table className="file-table">
            <thead>
              <tr>
                <th>이름</th>
                <th className="col-size">크기</th>
                <th className="col-actions"></th>
              </tr>
            </thead>
            <tbody>
              {items.map((node) => (
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
                  onClick={() => !trashMode && selectNode(node)}
                  onDoubleClick={() => !trashMode && node.type === 'folder' && openFolder(node)}
                >
                  <td>
                    <span className="node-icon">{node.type === 'folder' ? '📁' : '📄'}</span>{' '}
                    {node.name}
                  </td>
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
                            onRename(node)
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
              {items.length === 0 && (
                <tr>
                  <td colSpan={3} className="empty">
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
    </div>
  )
}
