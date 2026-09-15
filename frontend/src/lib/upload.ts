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

/** 진행 중인 업로드 하나. loaded/total 은 바이트. done/error는 완료 후에도 잠시 표시. */
export interface UploadItem {
  id: string
  name: string
  loaded: number
  total: number
  done?: boolean
  error?: boolean
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

/** 여러 id를 한 번에 제거(불변). 배치 완료 후 패널을 비울 때 사용. */
export function dropUploads(list: UploadItem[], ids: Set<string>): UploadItem[] {
  return list.filter((u) => !ids.has(u.id))
}

/** 항목을 완료로 표시(불변). error=true면 실패로. 성공 시 loaded=total로 바를 꽉 채운다. */
export function markUploadDone(list: UploadItem[], id: string, error = false): UploadItem[] {
  return list.map((u) =>
    u.id === id ? { ...u, done: true, error, loaded: error ? u.loaded : u.total } : u,
  )
}

/** 0~100 정수 퍼센트. total 0이면 0. */
export function percent(u: { loaded: number; total: number }): number {
  return u.total > 0 ? Math.min(100, Math.round((u.loaded / u.total) * 100)) : 0
}

/** 업로드 목록 요약: 전체/완료(성공)/실패 개수와 전체 진행 퍼센트. */
export function uploadSummary(list: UploadItem[]): {
  total: number
  done: number
  failed: number
  percent: number
} {
  const total = list.length
  const done = list.filter((u) => u.done && !u.error).length
  const failed = list.filter((u) => u.error).length
  const loadedBytes = list.reduce((s, u) => s + (u.done && !u.error ? u.total : u.loaded), 0)
  const totalBytes = list.reduce((s, u) => s + u.total, 0)
  const pct = totalBytes > 0 ? Math.min(100, Math.round((loadedBytes / totalBytes) * 100)) : 0
  return { total, done, failed, percent: pct }
}

/**
 * items를 최대 limit개까지 동시에 처리한다(간단한 워커 풀). 각 항목마다 worker를
 * 호출하고 모든 처리가 끝날 때까지 기다린다. worker가 던지면 그대로 전파된다.
 */
export async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let cursor = 0
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (cursor < items.length) {
      const i = cursor++
      await worker(items[i], i)
    }
  })
  await Promise.all(workers)
}
