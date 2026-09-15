/** source의 세로 스크롤 위치(비율)를 target의 scrollTop으로 환산한다.
 * 어느 쪽이든 스크롤할 여백이 없으면 0. 두 스크롤 컨테이너를 같은 비율로 맞출 때 쓴다. */
export function mappedScrollTop(
  source: { scrollTop: number; scrollHeight: number; clientHeight: number },
  target: { scrollHeight: number; clientHeight: number },
): number {
  const srcMax = source.scrollHeight - source.clientHeight
  const tgtMax = target.scrollHeight - target.clientHeight
  if (srcMax <= 0 || tgtMax <= 0) return 0
  const ratio = source.scrollTop / srcMax
  return Math.round(Math.min(1, Math.max(0, ratio)) * tgtMax)
}
