/** 툴바용 라인 아이콘 — VS Code 풍, currentColor 단색.
 *
 * stroke 기반이라 테마색을 그대로 따른다. 글자 화살표(↑ ↕ ⤓)를 쓰면 폰트마다 모양·두께가
 * 달라져 옆의 SVG 아이콘과 따로 논다. 아이콘은 전부 여기서 같은 규칙으로 그린다.
 *
 * **16px 에서 읽히는지가 기준이다.** 선이 많으면 그 크기에서 뭉갠다 — 실제로 서버 아이콘을
 * 고를 때 화살표 둘이 붙어 보이는 안을 걸러냈다.
 */
const svgProps = {
  width: 16,
  height: 16,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
}

export function IconRefresh({ className }: { className?: string }) {
  return (
    <svg {...svgProps} className={className}>
      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
      <path d="M21 3v6h-6" />
    </svg>
  )
}

export function IconFolderPlus() {
  return (
    <svg {...svgProps}>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <line x1="12" y1="11" x2="12" y2="17" />
      <line x1="9" y1="14" x2="15" y2="14" />
    </svg>
  )
}

export function IconFilePlus() {
  return (
    <svg {...svgProps}>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <polyline points="14 3 14 8 19 8" />
      <line x1="12" y1="12" x2="12" y2="18" />
      <line x1="9" y1="15" x2="15" y2="15" />
    </svg>
  )
}

/** 내려받기 — 아래 화살표 + **바닥선**. 업로드와 거울상이라 둘이 짝으로 읽힌다. */
export function IconDownload() {
  return (
    <svg {...svgProps}>
      <path d="M12 3v12" />
      <polyline points="7 10 12 15 17 10" />
      <path d="M4 19h16" />
    </svg>
  )
}

/** 내 PC 에서 올리기 — 위 화살표 + **천장선**. 다운로드를 위아래로 뒤집은 모양. */
export function IconUpload() {
  return (
    <svg {...svgProps}>
      <path d="M12 21V9" />
      <polyline points="7 14 12 9 17 14" />
      <path d="M4 5h16" />
    </svg>
  )
}

/** 서버(헤드리스) 전송 — 랙 + **양방향** 화살표.
 *
 * 이 버튼은 올리기와 내리기를 **둘 다** 한다(팝오버 안에 둘 다 있다). 그래서 한쪽
 * 화살표만 쓰면 기능을 절반만 말하게 된다. 랙을 위에 얹어 옆의 두 화살표 버튼과
 * 구분한다 — 저쪽은 '방향'이고 이쪽은 '목적지'다. */
export function IconServer() {
  return (
    <svg {...svgProps}>
      <rect x="3" y="3" width="18" height="6" rx="1" />
      <line x1="7" y1="6" x2="7.01" y2="6" />
      <path d="M8 21v-8" />
      <polyline points="5 16 8 13 11 16" />
      <path d="M16 13v8" />
      <polyline points="19 18 16 21 13 18" />
    </svg>
  )
}

/** 공유 링크 — 사슬. 넷 중 유일하게 화살표가 없어 성격이 다름이 드러난다. */
export function IconLink() {
  return (
    <svg {...svgProps}>
      <path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.5 1.5" />
      <path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.5-1.5" />
    </svg>
  )
}

/** 복사 — 사내 링크 복사 버튼에. 종이 두 장이 겹친 보편적인 모양. */
export function IconCopy() {
  return (
    <svg {...svgProps}>
      <rect x="9" y="9" width="12" height="12" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  )
}
