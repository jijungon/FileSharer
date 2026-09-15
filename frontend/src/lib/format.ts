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

/** 서버의 naive-UTC ISO 문자열을 Date로 (Z 없으면 UTC로 간주). 실패 시 null. */
function parseUtc(iso: string | null | undefined): Date | null {
  if (!iso) return null
  const d = new Date(/[zZ]|[+-]\d{2}:?\d{2}$/.test(iso) ? iso : `${iso}Z`)
  return Number.isNaN(d.getTime()) ? null : d
}

/** 서버의 naive-UTC ISO 문자열을 로컬 시각 "YYYY-MM-DD HH:mm"으로. */
export function formatDateTime(iso: string | null): string {
  const d = parseUtc(iso)
  if (!d) return '—'
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/**
 * 자동 완전삭제 예정 시각까지 남은 시간을 짧게 (예: "6일 23시간 남음").
 * 이미 지났으면 "곧 삭제됨", 값이 없거나 파싱 실패면 빈 문자열.
 */
export function formatTrashRemaining(
  purgeIso: string | null | undefined,
  now: number = Date.now(),
): string {
  const target = parseUtc(purgeIso)
  if (!target) return ''
  const ms = target.getTime() - now
  if (ms <= 0) return '곧 삭제됨'
  const DAY = 86_400_000
  const HOUR = 3_600_000
  const MIN = 60_000
  const days = Math.floor(ms / DAY)
  const hours = Math.floor((ms % DAY) / HOUR)
  if (days >= 1) return `${days}일 ${hours}시간 남음`
  if (hours >= 1) return `${hours}시간 남음`
  const mins = Math.floor((ms % HOUR) / MIN)
  return `${Math.max(1, mins)}분 남음`
}
