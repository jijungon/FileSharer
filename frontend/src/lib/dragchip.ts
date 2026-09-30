/** 끌 때 커서 옆에 따라붙는 작은 칩.
 *
 * 브라우저 기본 드래그 고스트는 **끌던 행 전체를 반투명하게 스냅샷**해서 따라다닌다.
 * 그게 드롭할 자리를 가려서 어디에 놓는지 안 보인다(#81). 그래서 커서 옆에 붙는
 * 작은 칩으로 바꿨다 — 무엇을 몇 개 끌고 있는지만 알려주고 시야는 막지 않는다.
 *
 * 트리와 휴지통 표가 **같은 모양**이어야 한다. 예전엔 트리에만 있어서 휴지통에서
 * 끌면 갑자기 큰 반투명 행이 따라붙었다. 같은 동작은 같아 보여야 한다.
 */

export interface DragChipSpec {
  /** 여러 개를 끌면 개수, 하나면 이름을 보여준다 */
  count: number
  name: string
  type: 'file' | 'folder'
}

/** 칩에 넣을 아이콘. 여러 개면 묶음, 하나면 폴더/파일. */
export function chipIcon(spec: DragChipSpec): string {
  if (spec.count > 1) return '🗂'
  return spec.type === 'folder' ? '📁' : '📄'
}

/** 칩에 넣을 글자. 여러 개면 "N개 항목", 하나면 그 이름. */
export function chipLabel(spec: DragChipSpec): string {
  return spec.count > 1 ? `${spec.count}개 항목` : spec.name
}

/**
 * 칩을 만들어 드래그 이미지로 건다.
 *
 * 칩은 화면 밖(-1000px)에 잠깐 붙였다가 뗀다 — 브라우저가 setDragImage 시점에
 * **스냅샷을 뜨므로** DOM 에 실제로 붙어 있어야 하고, 뜨고 난 뒤에는 필요 없다.
 * setDragImage 를 지원하지 않으면 조용히 기본 고스트로 둔다.
 */
export function attachDragChip(e: DragEvent | React.DragEvent, spec: DragChipSpec): void {
  if (typeof document === 'undefined' || !e.dataTransfer?.setDragImage) return

  const chip = document.createElement('div')
  chip.className = 'drag-chip'

  const icon = document.createElement('span')
  icon.className = 'drag-chip__icon'
  icon.textContent = chipIcon(spec)

  const name = document.createElement('span')
  name.className = 'drag-chip__name'
  name.textContent = chipLabel(spec)

  chip.append(icon, name)
  chip.style.position = 'absolute'
  chip.style.top = '-1000px'
  chip.style.left = '-1000px'
  document.body.appendChild(chip)

  try {
    e.dataTransfer.setDragImage(chip, 14, 18)
  } catch {
    /* 미지원 환경 — 기본 고스트로 폴백 */
  }
  setTimeout(() => chip.remove(), 0)
}
