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

/** 서버의 naive-UTC ISO 문자열을 로컬 시각 "YYYY-MM-DD HH:mm"으로. */
export function formatDateTime(iso: string | null): string {
  if (!iso) return '—'
  // 백엔드는 UTC(naive)로 보내므로 'Z'를 붙여 로컬로 변환
  const d = new Date(/[zZ]|[+-]\d{2}:?\d{2}$/.test(iso) ? iso : `${iso}Z`)
  if (Number.isNaN(d.getTime())) return '—'
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
