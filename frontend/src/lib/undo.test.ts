import { describe, expect, it } from 'vitest'
import { backTo, movedLabel, renamedLabel, trashedLabel } from './undo'

describe('backTo — 원래 자리로 돌려보낼 인자', () => {
  it('폴더 안에 있었으면 그 폴더로', () => {
    expect(backTo({ name: 'a.md', parent_id: 'f1', space_id: 's1' })).toEqual({
      name: 'a.md',
      move: true,
      parent_id: 'f1',
      space_id: 's1',
    })
  })

  it('공간 루트에 있었으면 parent 없이 그 공간으로', () => {
    expect(backTo({ name: 'a.md', parent_id: null, space_id: 's1' }).parent_id).toBeNull()
  })

  it('**이름도 함께** 되돌린다 — 이동만 해도 서버가 "(2)" 를 붙일 수 있다', () => {
    // 자리만 되돌리면 '보고서 (2).md' 가 남는다. 사람이 보기엔 안 되돌아간 것이다.
    expect(backTo({ name: '보고서.md', parent_id: 'f1', space_id: 's1' }).name).toBe('보고서.md')
  })
})

describe('라벨 — 방금 무슨 일이 있었나', () => {
  it('하나면 이름을, 여럿이면 개수를 말한다', () => {
    expect(movedLabel(['보고서.md'], '자료')).toBe("'보고서.md'를 '자료'로 옮겼습니다")
    expect(movedLabel(['a.md', 'b.md', 'c.md'], '자료')).toBe("3개를 '자료'로 옮겼습니다")
  })

  it('조사는 **따옴표 안 이름**의 마지막 글자를 따라간다', () => {
    // 따옴표 밖에서 고르면 전부 틀린다 — 마지막 글자는 언제나 ' 이기 때문이다.
    expect(movedLabel(['문서'], null)).toBe("'문서'를 옮겼습니다") // 서: 받침 없음
    expect(movedLabel(['문서들'], null)).toBe("'문서들'을 옮겼습니다") // 들: ㄹ 받침
    expect(movedLabel(['보고서.md'], null)).toBe("'보고서.md'를 옮겼습니다") // d → 디
    expect(movedLabel(['도면.dwg'], null)).toBe("'도면.dwg'를 옮겼습니다") // g → 지
  })

  it("가는 곳 조사도 이름을 따라간다 — '전체 공간로' 가 나가면 안 된다", () => {
    expect(movedLabel(['a'], '전체 공간')).toBe("'a'를 '전체 공간'으로 옮겼습니다")
    expect(movedLabel(['a'], '회사')).toBe("'a'를 '회사'로 옮겼습니다")
    expect(movedLabel(['a'], '서울')).toBe("'a'를 '서울'로 옮겼습니다") // ㄹ 받침은 '로'
  })

  it('이름을 다 모으지 못했으면 개수로 말한다', () => {
    // 일부만 알면 "'a'를" 처럼 나머지를 숨기는 말이 된다 — 개수가 정직하다.
    expect(trashedLabel(['a.md'], 3)).toBe('3개를 휴지통으로 보냈습니다')
    expect(trashedLabel([], 2)).toBe('2개를 휴지통으로 보냈습니다')
    expect(trashedLabel(['a.md'], 1)).toBe("'a.md'를 휴지통으로 보냈습니다")
  })

  it('이름 바꾸기는 옛 이름과 새 이름을 둘 다 말한다', () => {
    expect(renamedLabel('초안', '최종본')).toBe("'초안'을 '최종본'으로 바꿨습니다")
  })
})
