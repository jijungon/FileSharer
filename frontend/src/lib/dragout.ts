import { NodeInfo, downloadUrl } from './files'

/** 크롬 계열 전용 DownloadURL 문자열: "mime:파일명:절대URL".
 *  폴더는 tar.gz로 떨어지므로 이름에 .tar.gz를 붙인다. */
export function downloadUrlData(node: NodeInfo, origin: string): string {
  const mime = node.type === 'file' ? node.mime || 'application/octet-stream' : 'application/gzip'
  const name = node.type === 'file' ? node.name : `${node.name}.tar.gz`
  // DownloadURL 구분자가 ':'라 이름의 ':'는 제거
  const safeName = name.replaceAll(':', '_')
  return `${mime}:${safeName}:${origin}${downloadUrl(node)}`
}

export function supportsDragOut(): boolean {
  return typeof navigator !== 'undefined' && /chrome|chromium|edg\//i.test(navigator.userAgent)
}
