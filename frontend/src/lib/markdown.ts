import { api } from './api'
import { NodeInfo } from './files'

const TEXT_EXTS = ['md', 'markdown', 'txt', 'log', 'json', 'yml', 'yaml', 'csv']

export function extOf(name: string): string {
  const i = name.lastIndexOf('.')
  return i === -1 ? '' : name.slice(i + 1).toLowerCase()
}

/** 편집기로 열 수 있는 텍스트 파일인가 */
export function isTextFile(node: NodeInfo): boolean {
  if (node.type !== 'file') return false
  if (node.mime.startsWith('text/')) return true
  return TEXT_EXTS.includes(extOf(node.name))
}

/** 우측 렌더링이 마크다운인 파일 */
export function isMarkdown(node: NodeInfo): boolean {
  return ['md', 'markdown'].includes(extOf(node.name))
}

export async function fetchText(nodeId: string): Promise<string> {
  const res = await fetch(`/api/files/${nodeId}/raw`)
  if (!res.ok) throw new Error(`불러오기 실패 (${res.status})`)
  return await res.text()
}

export const saveContent = (nodeId: string, content: string, baseUpdatedAt: string | null) =>
  api<NodeInfo>(`/api/files/${nodeId}/content`, {
    method: 'PUT',
    body: JSON.stringify({ content, base_updated_at: baseUpdatedAt }),
  })

const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif']

export function isImage(node: NodeInfo): boolean {
  if (node.type !== 'file') return false
  return node.mime.startsWith('image/') || IMAGE_EXTS.includes(extOf(node.name))
}

export function isPdf(node: NodeInfo): boolean {
  if (node.type !== 'file') return false
  return node.mime === 'application/pdf' || extOf(node.name) === 'pdf'
}
