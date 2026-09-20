import { api } from './api'

export interface NodeInfo {
  id: string
  space_id: string
  parent_id: string | null
  type: 'folder' | 'file'
  name: string
  size: number
  mime: string
  created_at: string | null
  updated_at: string | null
  // 표시용 닉네임(이메일 @ 앞부분): 업로더=생성자, editor=마지막 수정자(없으면 업로더)
  uploader?: string
  editor?: string
  // 휴지통 목록에서만 채워짐: 삭제 시각과 자동 완전삭제 예정 시각(서버 계산)
  deleted_at?: string | null
  purge_at?: string | null
  // 검색 결과에만 채워짐: 상위 폴더 경로(공간 루트 기준 'a/b/c', 루트면 '')
  path?: string
}

export interface NodePath {
  node: NodeInfo
  ancestors: NodeInfo[]
  space_id: string
}

export interface FolderRow {
  id: string
  name: string
  parent_id: string | null
}

// 사이드바 파일 트리(파일+폴더 전체). 파일 클릭 시 열 수 있게 type/mime/size 포함.
export interface TreeRow {
  id: string
  name: string
  parent_id: string | null
  type: 'folder' | 'file'
  mime: string
  size: number
}

export const listSpaceChildren = (spaceId: string) =>
  api<NodeInfo[]>(`/api/spaces/${spaceId}/children`)

export const listSpaceFolders = (spaceId: string) =>
  api<FolderRow[]>(`/api/spaces/${spaceId}/folders`)

/** 공간의 파일+폴더 전체(트리 탐색기용). */
export const listSpaceTree = (spaceId: string) =>
  api<TreeRow[]>(`/api/spaces/${spaceId}/tree`)

export const listNodeChildren = (nodeId: string) => api<NodeInfo[]>(`/api/nodes/${nodeId}/children`)

export const listTrash = (spaceId: string) => api<NodeInfo[]>(`/api/spaces/${spaceId}/trash`)

/** 공간 안에서 이름으로 검색(재귀). 결과 각 항목엔 상위 경로(path)가 담긴다. */
export const searchNodes = (spaceId: string, q: string) =>
  api<NodeInfo[]>(`/api/spaces/${spaceId}/search?q=${encodeURIComponent(q)}`)

/** 내 즐겨찾기 항목(경로 포함, 최근 추가순). */
export const listFavorites = () => api<NodeInfo[]>('/api/favorites')
/** 내가 즐겨찾기한 노드 id들(별표 상태 표시용). */
export const listFavoriteIds = () => api<string[]>('/api/favorites/ids')
export const addFavorite = (id: string) =>
  api<{ favorited: boolean }>(`/api/nodes/${id}/favorite`, { method: 'POST' })
export const removeFavorite = (id: string) =>
  api<{ favorited: boolean }>(`/api/nodes/${id}/favorite`, { method: 'DELETE' })

/** 항목 열람 기록('최근 열어본 항목'용). 파일을 열 때 호출. */
export const recordView = (id: string) =>
  api<{ ok: boolean }>(`/api/nodes/${id}/view`, { method: 'POST' })
/** 내가 최근 열어본 항목(경로 포함, 최근 열람순). */
export const listRecent = () => api<NodeInfo[]>('/api/recent')

/** 편집 잠금 상태. held_by_me면 내가 편집 중(편집 가능), 아니면 holder가 편집 중(읽기 전용). */
export interface LockState {
  held_by_me: boolean
  holder: string
}
/** 편집 잠금 획득/갱신(하트비트). 주기적으로 호출하면 내 잠금 유지 + 남의 잠금이 풀리면 인수. */
export const acquireLock = (id: string) =>
  api<LockState>(`/api/nodes/${id}/lock`, { method: 'POST' })
/** 편집 잠금 해제(에디터 닫기/이탈). 이탈 중에도 확실히 가도록 sendBeacon 우선. */
export function releaseLock(id: string) {
  const url = `/api/nodes/${id}/lock/release`
  try {
    if (navigator.sendBeacon) navigator.sendBeacon(url)
    else fetch(url, { method: 'POST', credentials: 'same-origin', keepalive: true }).catch(() => {})
  } catch {
    /* 이탈 중 실패해도 서버가 TTL(30초)로 정리하므로 무방 */
  }
}

export const getNodePath = (nodeId: string) => api<NodePath>(`/api/nodes/${nodeId}/path`)

export const createFolder = (spaceId: string, parentId: string | null, name: string) =>
  api<NodeInfo>('/api/nodes', {
    method: 'POST',
    body: JSON.stringify({ space_id: spaceId, parent_id: parentId, name }),
  })

export function uploadFile(
  target: { spaceId: string; parentId: string | null },
  file: File,
  relPath?: string,
  onProgress?: (loaded: number, total: number) => void,
): Promise<NodeInfo> {
  const url = target.parentId
    ? `/api/nodes/${target.parentId}/files`
    : `/api/spaces/${target.spaceId}/files`
  const form = new FormData()
  form.append('file', file)
  // 폴더 업로드: 상대 경로를 보내면 서버가 중간 폴더를 만들어(있으면 재사용) 그 안에 넣는다
  if (relPath) form.append('rel_path', relPath)
  // 업로드 진행률(upload.onprogress)이 필요해 fetch 대신 XHR 사용. 같은 오리진이라 쿠키 자동 전송.
  return new Promise<NodeInfo>((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', url)
    xhr.responseType = 'json'
    if (onProgress) {
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress(e.loaded, e.total)
      }
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(xhr.response as NodeInfo)
      } else {
        const detail = (xhr.response as { detail?: string } | null)?.detail
        reject(new Error(detail ?? `업로드 실패 (${xhr.status})`))
      }
    }
    xhr.onerror = () => reject(new Error('업로드 실패 (네트워크)'))
    xhr.send(form)
  })
}

export const renameNode = (id: string, name: string) =>
  api<NodeInfo>(`/api/nodes/${id}`, { method: 'PATCH', body: JSON.stringify({ name }) })

export const moveNode = (id: string, target: { parentId?: string; spaceId?: string }) =>
  api<NodeInfo>(`/api/nodes/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({
      move: true,
      parent_id: target.parentId ?? null,
      space_id: target.spaceId ?? null,
    }),
  })

export const copyNode = (id: string, target: { parentId?: string; spaceId?: string }) =>
  api<NodeInfo>(`/api/nodes/${id}/copy`, {
    method: 'POST',
    body: JSON.stringify({
      parent_id: target.parentId ?? null,
      space_id: target.spaceId ?? null,
    }),
  })

export const deleteNode = (id: string) => api(`/api/nodes/${id}`, { method: 'DELETE' })

export const restoreNode = (id: string) =>
  api<NodeInfo>(`/api/nodes/${id}/restore`, { method: 'POST' })

// 휴지통 항목 영구 삭제(본인). 되돌릴 수 없음.
export const purgeNode = (id: string) =>
  api<{ ok: boolean; removed: number }>(`/api/nodes/${id}/purge`, { method: 'DELETE' })

export const downloadUrl = (node: NodeInfo) =>
  node.type === 'file' ? `/api/files/${node.id}` : `/api/nodes/${node.id}/tar`
