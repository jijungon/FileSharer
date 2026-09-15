/** 업로드 전 파일을 크기 제한(maxMb)으로 통과/초과로 분리한다.
 * maxMb <= 0 (아직 미로딩 등)이면 검사하지 않고 모두 통과시킨다. */
export function partitionBySize<T>(
  items: T[],
  maxMb: number,
  sizeOf: (item: T) => number,
): { ok: T[]; tooBig: T[] } {
  if (!maxMb || maxMb <= 0) return { ok: items, tooBig: [] }
  const limit = maxMb * 1024 * 1024
  const ok: T[] = []
  const tooBig: T[] = []
  for (const item of items) {
    ;(sizeOf(item) > limit ? tooBig : ok).push(item)
  }
  return { ok, tooBig }
}

/** 진행 중인 업로드 하나. loaded/total 은 바이트. */
export interface UploadItem {
  id: string
  name: string
  loaded: number
  total: number
}

/** id에 해당하는 항목의 진행률을 갱신(불변). 없으면 그대로. */
export function setProgress(
  list: UploadItem[],
  id: string,
  loaded: number,
  total: number,
): UploadItem[] {
  return list.map((u) => (u.id === id ? { ...u, loaded, total } : u))
}

/** 완료/실패한 업로드 제거(불변). */
export function dropUpload(list: UploadItem[], id: string): UploadItem[] {
  return list.filter((u) => u.id !== id)
}

/** 0~100 정수 퍼센트. total 0이면 0. */
export function percent(u: { loaded: number; total: number }): number {
  return u.total > 0 ? Math.min(100, Math.round((u.loaded / u.total) * 100)) : 0
}
