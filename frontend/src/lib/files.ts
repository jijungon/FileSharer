import { api } from './api'

export interface NodeInfo {
  id: string
  space_id: string
  parent_id: string | null
  type: 'folder' | 'file'
  name: string
  size: number
  mime: string
  updated_at: string | null
}

export interface NodePath {
  node: NodeInfo
  ancestors: NodeInfo[]
  space_id: string
}

export const listSpaceChildren = (spaceId: string) =>
  api<NodeInfo[]>(`/api/spaces/${spaceId}/children`)

export const listNodeChildren = (nodeId: string) => api<NodeInfo[]>(`/api/nodes/${nodeId}/children`)

export const listTrash = (spaceId: string) => api<NodeInfo[]>(`/api/spaces/${spaceId}/trash`)

export const getNodePath = (nodeId: string) => api<NodePath>(`/api/nodes/${nodeId}/path`)

export const createFolder = (spaceId: string, parentId: string | null, name: string) =>
  api<NodeInfo>('/api/nodes', {
    method: 'POST',
    body: JSON.stringify({ space_id: spaceId, parent_id: parentId, name }),
  })

export async function uploadFile(
  target: { spaceId: string; parentId: string | null },
  file: File,
): Promise<NodeInfo> {
  const url = target.parentId
    ? `/api/nodes/${target.parentId}/files`
    : `/api/spaces/${target.spaceId}/files`
  const form = new FormData()
  form.append('file', file)
  const res = await fetch(url, { method: 'POST', body: form })
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { detail?: string } | null
    throw new Error(body?.detail ?? `업로드 실패 (${res.status})`)
  }
  return (await res.json()) as NodeInfo
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

export const deleteNode = (id: string) => api(`/api/nodes/${id}`, { method: 'DELETE' })

export const restoreNode = (id: string) =>
  api<NodeInfo>(`/api/nodes/${id}/restore`, { method: 'POST' })

export const downloadUrl = (node: NodeInfo) =>
  node.type === 'file' ? `/api/files/${node.id}` : `/api/nodes/${node.id}/tar`
