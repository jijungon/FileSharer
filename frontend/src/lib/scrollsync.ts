import { RefObject, useEffect } from 'react'

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

/** 두 스크롤 컨테이너(에디터/프리뷰)를 양방향 비율 스크롤 동기화한다.
 * 한쪽을 움직이면 반대쪽도 같은 위치로 따라온다. rAF lock으로 피드백 루프 방지. */
export function useScrollSync(
  aRef: RefObject<HTMLElement | null>,
  bRef: RefObject<HTMLElement | null>,
  enabled = true,
): void {
  useEffect(() => {
    if (!enabled) return
    const a = aRef.current
    const b = bRef.current
    if (!a || !b) return
    let lock = false
    const make = (src: HTMLElement, tgt: HTMLElement) => () => {
      if (lock) return
      lock = true
      tgt.scrollTop = mappedScrollTop(src, tgt)
      requestAnimationFrame(() => {
        lock = false
      })
    }
    const onA = make(a, b)
    const onB = make(b, a)
    a.addEventListener('scroll', onA, { passive: true })
    b.addEventListener('scroll', onB, { passive: true })
    return () => {
      a.removeEventListener('scroll', onA)
      b.removeEventListener('scroll', onB)
    }
  }, [aRef, bRef, enabled])
}
