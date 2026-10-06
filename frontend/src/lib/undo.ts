import { eul, ro } from './josa'

/** 되돌리기 — **직전 한 번만.**
 *
 * 여러 단계를 쌓으면 "그 사이 남이 그 파일을 건드렸으면?" 을 전부 다뤄야 한다. 사내용이고
 * 같은 파일을 동시에 만지는 일이 드무니, 실제로 아픈 자리(드래그 실수)만 먼저 막는다.
 *
 * **왜 서버가 '바뀌기 전' 을 돌려주나**: 클라이언트가 자기 목록에서 추측하게 두면, 끌어온
 * 항목이 그 목록에 없을 때(사이드바 트리·검색 결과) 조용히 틀린 자리로 돌아간다.
 * PATCH /api/nodes/{id} 응답의 previous 가 진짜 값이다.
 */
export interface Undoable {
  /** 사람에게 보여줄 말 — 방금 무슨 일이 있었는지. */
  label: string
  /** 역연산. 실패하면 던진다(호출하는 쪽이 알린다). */
  run: () => Promise<void>
}

/** 서버가 알려준 '바뀌기 전'. */
export interface Previous {
  name: string
  parent_id: string | null
  space_id: string
}

/** 원래 자리로 돌려보낼 인자.
 *
 * 폴더 안에 있었으면 그 폴더로, 공간 루트에 있었으면 그 공간으로. **이름도 함께** 되돌린다
 * — 이동만 해도 이름이 바뀔 수 있기 때문이다(대상에 같은 이름이 있으면 서버가 "(2)" 를
 * 붙인다). 자리만 되돌리면 '보고서 (2).md' 가 남는다.
 */
export function backTo(prev: Previous): {
  name: string
  move: true
  parent_id: string | null
  space_id: string
} {
  return {
    name: prev.name,
    move: true,
    parent_id: prev.parent_id,
    space_id: prev.space_id,
  }
}

/** 하나면 이름을, 여럿이면 개수를 말한다.
 *
 * "'보고서.md'를" 처럼 **따옴표 밖에서** 조사를 고르면 틀린다 — 조사는 이름의 마지막
 * 글자를 따라가야 한다. josa 가 그걸 한다.
 */
function what(names: string[], count = names.length): string {
  // 이름을 **전부** 알 때만 이름으로 말한다. 일부만 알면 "'a'를"처럼 나머지를 숨기는
  // 말이 되어, 방금 무슨 일이 있었는지 틀리게 알려준다. 그럴 땐 개수가 정직하다.
  if (count === 1 && names.length === 1) return `'${names[0]}'${eul(names[0])}`
  return `${count}개${eul('개')}`
}

/** "'보고서.md'를 '자료'로 옮겼습니다" · "3개를 '자료'로 옮겼습니다" */
export function movedLabel(names: string[], targetName?: string | null): string {
  if (!targetName) return `${what(names)} 옮겼습니다`
  return `${what(names)} '${targetName}'${ro(targetName)} 옮겼습니다`
}

/** "'보고서.md'를 휴지통으로 보냈습니다". 이름을 다 모으지 못했으면 개수로 말한다. */
export function trashedLabel(names: string[], count: number): string {
  return `${what(names, count)} 휴지통으로 보냈습니다`
}

/** "'옛이름'을 '새이름'으로 바꿨습니다" */
export function renamedLabel(from: string, to: string): string {
  return `'${from}'${eul(from)} '${to}'${ro(to)} 바꿨습니다`
}
