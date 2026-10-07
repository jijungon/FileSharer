/** 탭 우클릭 메뉴가 "무엇을 닫을지" 를 정하는 규칙.
 *
 * 계산을 화면에서 떼어 둔다 — 어느 탭이 사라지는지는 **되돌릴 수 없는 결정**이라
 * (미저장 내용이 날아갈 수 있다) 눈으로 훑어서는 안심할 수 없다.
 */

/** 메뉴에서 고를 수 있는 일. */
export type TabAction = 'this' | 'others' | 'all'

/** 그 일을 하면 닫히는 탭 id 들. 순서는 원래 탭 순서를 따른다. */
export function tabsToClose<T extends { id: string }>(
  tabs: T[],
  targetId: string,
  action: TabAction,
): string[] {
  if (!tabs.some((t) => t.id === targetId)) return [] // 이미 닫힌 탭 위의 메뉴 — 아무것도 안 한다
  switch (action) {
    case 'this':
      return [targetId]
    case 'others':
      return tabs.filter((t) => t.id !== targetId).map((t) => t.id)
    case 'all':
      return tabs.map((t) => t.id)
  }
}

/** 지금 상황에서 그 항목을 누를 수 있나.
 *
 * 누를 수 없는 항목을 **지우지 않고 흐리게** 둔다. 탭이 하나일 때 메뉴가 통째로
 * 달라지면, 다음에 열었을 때 같은 자리에 다른 것이 있어 잘못 누르게 된다.
 */
export function canDo<T extends { id: string }>(
  tabs: T[],
  targetId: string,
  action: TabAction,
): boolean {
  return tabsToClose(tabs, targetId, action).length > 0
}

/** 닫고 난 뒤 어느 탭으로 갈까.
 *
 * 오른쪽 이웃을 먼저 본다(닫은 자리에 올라오는 것), 없으면 왼쪽. 둘 다 없으면 null —
 * 열린 탭이 하나도 안 남았다는 뜻이다.
 *
 * **보던 탭이 안 닫히면 그대로 둔다.** '다른 탭 모두 닫기' 가 그 경우다. 처음엔
 * "닫힐 때만 부른다" 는 약속으로 두려 했는데, 그러면 부르는 쪽이 매번 기억해야 하고
 * 한 번만 잊어도 화면이 엉뚱한 파일로 튄다. 함수가 알아서 맞는 편이 싸다.
 */
export function nextActive<T extends { id: string }>(
  tabs: T[],
  closing: Set<string>,
  activeId: string,
): T | null {
  const at = tabs.findIndex((t) => t.id === activeId)
  if (at !== -1 && !closing.has(activeId)) return tabs[at] // 보던 것이 그대로 남는다
  const left = tabs.filter((t) => !closing.has(t.id))
  if (left.length === 0 || at === -1) return null
  // 원래 자리보다 **뒤에** 남아 있는 첫 탭, 없으면 **앞에** 남아 있는 마지막 탭
  const after = tabs.slice(at + 1).find((t) => !closing.has(t.id))
  if (after) return after
  const before = tabs.slice(0, at).filter((t) => !closing.has(t.id))
  return before[before.length - 1] ?? null
}
