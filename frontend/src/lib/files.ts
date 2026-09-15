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

export const listSpaceChildren = (spaceId: string) =>
  api<NodeInfo[]>(`/api/spaces/${spaceId}/children`)

export const listSpaceFolders = (spaceId: string) =>
  api<FolderRow[]>(`/api/spaces/${spaceId}/folders`)

export const listNodeChildren = (nodeId: string) => api<NodeInfo[]>(`/api/nodes/${nodeId}/children`)

export const listTrash = (spaceId: string) => api<NodeInfo[]>(`/api/spaces/${spaceId}/trash`)

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
