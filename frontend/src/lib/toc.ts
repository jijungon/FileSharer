/** 마크다운에서 `#`/`##`/`###` 목차를 뽑는다 (공유 페이지 좌측 목차용).
 *
 * id는 **제목의 줄 번호**(`h12`)다. 제목 글자로 slug를 만들면
 *  - 같은 제목이 두 번 나올 때 중복되고,
 *  - `**굵게**`·`[링크](…)` 같은 인라인 서식을 벗기는 방식이 렌더러와 조금만 달라도 어긋난다.
 * 본문 렌더러(MarkdownPreview)도 remark가 준 줄 번호로 같은 id를 달기 때문에 항상 맞는다.
 */
export interface TocItem {
  level: 1 | 2 | 3
  text: string
  id: string
}

/** 제목에서 id를 만든다 — 렌더러와 목차가 공유하는 단 하나의 규칙. */
export function headingIdForLine(line: number): string {
  return `h${line}`
}

const FENCE = /^\s*(```+|~~~+)/
const HEADING = /^(#{1,3})\s+(.+?)\s*#*\s*$/

/** 표시용으로 인라인 서식만 벗긴다(id는 줄 번호라 여기 결과에 영향받지 않는다). */
function plain(s: string): string {
  return s
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_~]/g, '')
    .trim()
}

export function extractToc(md: string): TocItem[] {
  const out: TocItem[] = []
  let fence = '' // 코드블록 안의 주석(`# 설치`)을 제목으로 오인하지 않게
  md.split('\n').forEach((raw, i) => {
    const f = FENCE.exec(raw)
    if (f) {
      if (!fence) fence = f[1][0]
      else if (raw.trim().startsWith(fence)) fence = ''
      return
    }
    if (fence) return
    const m = HEADING.exec(raw)
    if (!m) return
    const text = plain(m[2])
    if (text)
      out.push({
        level: m[1].length as 1 | 2 | 3,
        text,
        id: headingIdForLine(i + 1),
      })
  })
  return out
}
