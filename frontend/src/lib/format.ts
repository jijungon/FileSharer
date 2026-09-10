const UNITS = ['B', 'KB', 'MB', 'GB', 'TB']

/** 바이트 수를 사람이 읽는 단위로 (예: 1536 -> "1.5 KB") */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '-'
  if (bytes < 1024) return `${bytes} B`
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024
    unit += 1
  }
  const rounded = value >= 100 ? Math.round(value).toString() : value.toFixed(1)
  return `${rounded} ${UNITS[unit]}`
}

/** macOS가 보내는 NFD 한글 파일명을 NFC로 정규화 */
export function normalizeFileName(name: string): string {
  return name.normalize('NFC')
}
