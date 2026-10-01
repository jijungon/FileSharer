import { api } from './api'
import { NodeInfo } from './files'

/** 형식 판별에 필요한 **최소한의 모양**.
 *
 * 앱 안의 NodeInfo 와 공유 페이지의 ShareMeta 가 둘 다 이걸 만족한다. 같은 파일을
 * 두 화면이 다르게 판정하면("앱에선 보이는데 공유에선 안 보인다") 사용자만 헷갈린다. */
export interface FileLike {
  type: string
  name: string
  mime: string
}

// 편집기로 여는 텍스트 확장자. 문서(md·txt·csv…)에 더해 코드·설정 파일도 포함해
// 문법 강조로 보기/편집할 수 있게 한다. (.html은 렌더 뷰(isHtml)가 먼저 잡으므로 제외)
const TEXT_EXTS = [
  'md', 'markdown', 'txt', 'log', 'json', 'yml', 'yaml', 'csv', 'tsv',
  'sh', 'bash', 'zsh', 'py', 'rb', 'pl', 'lua', 'r',
  'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs',
  'css', 'scss', 'less', 'xml', 'svg', 'sql',
  'toml', 'ini', 'conf', 'cfg', 'env', 'properties', 'dockerfile', 'makefile', 'gitignore',
  'go', 'rs', 'java', 'kt', 'swift', 'php', 'c', 'h', 'cpp', 'cc', 'hpp', 'cs',
  'tf', 'gradle',
]

export function extOf(name: string): string {
  const i = name.lastIndexOf('.')
  return i === -1 ? '' : name.slice(i + 1).toLowerCase()
}

/** 편집기로 열 수 있는 텍스트 파일인가 */
export function isTextFile(node: FileLike): boolean {
  if (node.type !== 'file') return false
  if (node.mime.startsWith('text/')) return true
  return TEXT_EXTS.includes(extOf(node.name))
}

/** 우측 렌더링이 마크다운인 파일 */
export function isMarkdown(node: FileLike): boolean {
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

export function isImage(node: FileLike): boolean {
  if (node.type !== 'file') return false
  return node.mime.startsWith('image/') || IMAGE_EXTS.includes(extOf(node.name))
}

export function isPdf(node: FileLike): boolean {
  if (node.type !== 'file') return false
  return node.mime === 'application/pdf' || extOf(node.name) === 'pdf'
}

const VIDEO_EXTS = ['mp4', 'webm', 'ogv', 'mov', 'm4v', 'mkv']
const AUDIO_EXTS = ['mp3', 'wav', 'ogg', 'oga', 'm4a', 'aac', 'flac', 'weba']
const HTML_EXTS = ['html', 'htm']

export function isVideo(node: FileLike): boolean {
  if (node.type !== 'file') return false
  return node.mime.startsWith('video/') || VIDEO_EXTS.includes(extOf(node.name))
}

export function isAudio(node: FileLike): boolean {
  if (node.type !== 'file') return false
  return node.mime.startsWith('audio/') || AUDIO_EXTS.includes(extOf(node.name))
}

export function isHtml(node: FileLike): boolean {
  if (node.type !== 'file') return false
  return node.mime === 'text/html' || HTML_EXTS.includes(extOf(node.name))
}

// hwp=한글 구형, hwpx=한글 신형(h2orestart 확장으로 PDF 변환).
const OFFICE_EXTS = ['ppt', 'pptx', 'doc', 'docx', 'xls', 'xlsx', 'odp', 'ods', 'odt', 'hwp', 'hwpx']

/** PPT·워드·엑셀 등 — 서버에서 PDF로 변환해 미리보기 */
export function isOffice(node: FileLike): boolean {
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
  { label: '오피스·한글', exts: '.ppt .pptx .doc .docx .xls .xlsx .hwp .hwpx (PDF로 변환)' },
]
