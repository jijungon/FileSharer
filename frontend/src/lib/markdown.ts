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

const VIDEO_EXTS = ['mp4', 'webm', 'ogv', 'mov', 'm4v', 'mkv']
const AUDIO_EXTS = ['mp3', 'wav', 'ogg', 'oga', 'm4a', 'aac', 'flac', 'weba']
const HTML_EXTS = ['html', 'htm']

export function isVideo(node: NodeInfo): boolean {
  if (node.type !== 'file') return false
  return node.mime.startsWith('video/') || VIDEO_EXTS.includes(extOf(node.name))
}

export function isAudio(node: NodeInfo): boolean {
  if (node.type !== 'file') return false
  return node.mime.startsWith('audio/') || AUDIO_EXTS.includes(extOf(node.name))
}

export function isHtml(node: NodeInfo): boolean {
  if (node.type !== 'file') return false
  return node.mime === 'text/html' || HTML_EXTS.includes(extOf(node.name))
}

const OFFICE_EXTS = ['ppt', 'pptx', 'doc', 'docx', 'xls', 'xlsx', 'odp', 'ods', 'odt']

/** PPT·워드·엑셀 등 — 서버에서 PDF로 변환해 미리보기 */
export function isOffice(node: NodeInfo): boolean {
  if (node.type !== 'file') return false
  return OFFICE_EXTS.includes(extOf(node.name))
}

/** 사용자 안내용 — 미리보기(뷰어)가 지원하는 형식 요약 */
export const SUPPORTED_PREVIEW: { label: string; exts: string }[] = [
  { label: '마크다운', exts: '.md .markdown' },
  { label: '텍스트·코드', exts: '.txt .log .json .yml .yaml .csv' },
  { label: '이미지', exts: '.png .jpg .gif .webp .svg .bmp .avif' },
  { label: 'PDF', exts: '.pdf' },
  { label: '영상', exts: '.mp4 .webm .mov .m4v .ogv' },
  { label: '음성', exts: '.mp3 .wav .ogg .m4a .aac .flac' },
  { label: 'HTML', exts: '.html .htm (스크립트 미실행)' },
  { label: '오피스', exts: '.ppt .pptx .doc .docx .xls .xlsx (PDF로 변환)' },
]
