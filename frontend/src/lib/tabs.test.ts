import { describe, expect, it } from 'vitest'
import { canDo, nextActive, tabsToClose } from './tabs'

const tabs = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }]

describe('tabsToClose — 무엇이 닫히나', () => {
  it('이 탭 / 다른 탭 모두 / 오른쪽 / 모두', () => {
    expect(tabsToClose(tabs, 'b', 'this')).toEqual(['b'])
    expect(tabsToClose(tabs, 'b', 'others')).toEqual(['a', 'c', 'd'])
    expect(tabsToClose(tabs, 'b', 'right')).toEqual(['c', 'd'])
    expect(tabsToClose(tabs, 'b', 'all')).toEqual(['a', 'b', 'c', 'd'])
  })

  it('맨 오른쪽 탭에서는 "오른쪽" 이 빈다', () => {
    expect(tabsToClose(tabs, 'd', 'right')).toEqual([])
  })

  it('탭이 하나면 "다른 탭 모두" 가 빈다 — 자기를 닫아버리면 안 된다', () => {
    expect(tabsToClose([{ id: 'a' }], 'a', 'others')).toEqual([])
    expect(tabsToClose([{ id: 'a' }], 'a', 'all')).toEqual(['a'])
  })

  it('이미 닫힌 탭 위의 메뉴면 아무것도 닫지 않는다', () => {
    // 메뉴가 떠 있는 사이 그 탭이 사라질 수 있다(다른 세션에서 파일 삭제 등)
    expect(tabsToClose(tabs, '없는탭', 'all')).toEqual([])
    expect(tabsToClose(tabs, '없는탭', 'this')).toEqual([])
  })
})

describe('canDo — 누를 수 있나', () => {
  it('닫을 게 없으면 못 누른다', () => {
    expect(canDo(tabs, 'd', 'right')).toBe(false)
    expect(canDo(tabs, 'b', 'right')).toBe(true)
    expect(canDo([{ id: 'a' }], 'a', 'others')).toBe(false)
  })
})

describe('nextActive — 닫고 나서 어디로', () => {
  it('오른쪽 이웃을 먼저 — 닫은 자리에 올라오는 것', () => {
    expect(nextActive(tabs, new Set(['b']), 'b')?.id).toBe('c')
  })

  it('오른쪽이 다 닫히면 왼쪽으로', () => {
    expect(nextActive(tabs, new Set(['b', 'c', 'd']), 'b')?.id).toBe('a')
  })

  it('맨 끝 탭을 닫으면 그 왼쪽으로', () => {
    expect(nextActive(tabs, new Set(['d']), 'd')?.id).toBe('c')
  })

  it('전부 닫으면 갈 곳이 없다', () => {
    expect(nextActive(tabs, new Set(['a', 'b', 'c', 'd']), 'b')).toBeNull()
  })

  it('"다른 탭 모두 닫기" 면 자기 자신이 남는다', () => {
    expect(nextActive(tabs, new Set(['a', 'c', 'd']), 'b')?.id).toBe('b')
  })
})
