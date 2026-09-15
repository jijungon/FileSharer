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
