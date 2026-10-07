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

/** 바이트는 다 보냈는데 **아직 서버 답이 안 온** 상태인가.
 *
 * 게이지(xhr.upload.onprogress)는 바이트가 브라우저를 떠날 때 차오르고, 완료(xhr.onload)는
 * 서버가 201 로 답해야 찍힌다. 그 사이에 서버가 할 일이 남아 있다 — 받은 내용을 저장소에
 * 쓰고(R2 면 거기로 다시 올린다), SHA-256 을 계산하고, DB 에 쓰고, 텍스트면 내용 검색
 * 인덱스에 적재한다.
 *
 * 그래서 게이지 셋이 거의 동시에 100% 에 닿아도 숫자는 1/3 → 2/3 → 3/3 으로 따라온다.
 * **화면이 100% 에서 멈춘 것처럼 보였다** — 실제로 "이건 뭐지?" 라는 질문을 받았다.
 *
 * **상태를 따로 두지 않는다.** loaded·total·done 이 이미 답을 갖고 있고, 별도 플래그를
 * 두면 언젠가 실제와 어긋난다(바는 꽉 찼는데 '저장 중' 이 아니거나 그 반대).
 *
 * 0 바이트 파일은 보낼 것이 없으니 곧바로 이 상태다 — 0% 라고 적는 것보다 맞다.
 */
export function isSaving(u: UploadItem): boolean {
  return !u.done && !u.error && u.loaded >= u.total
}

/** 그 줄에 적을 말. 퍼센트가 아니라 **지금 무슨 일이 벌어지는지**를 적는다. */
export function statusLabel(u: UploadItem): string {
  if (u.error) return '실패'
  if (isSaving(u)) return '저장 중…'
  return `${percent(u)}%`
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
