import { describe, expect, it } from 'vitest'
import { chipIcon, chipLabel } from './dragchip'

describe('드래그 칩', () => {
  it('하나를 끌면 그 이름과 파일 아이콘', () => {
    const spec = { count: 1, name: '회의록.md', type: 'file' as const }
    expect(chipIcon(spec)).toBe('📄')
    expect(chipLabel(spec)).toBe('회의록.md')
  })

  it('폴더 하나면 폴더 아이콘', () => {
    expect(chipIcon({ count: 1, name: '계약서', type: 'folder' })).toBe('📁')
  })

  it('여러 개면 개수로 바꾸고 묶음 아이콘', () => {
    // 이름을 나열하면 칩이 커져 드롭 위치를 가린다 — 개수만 보여준다
    const spec = { count: 3, name: '회의록.md', type: 'file' as const }
    expect(chipIcon(spec)).toBe('🗂')
    expect(chipLabel(spec)).toBe('3개 항목')
  })

  it('여럿일 땐 폴더든 파일이든 같은 아이콘', () => {
    expect(chipIcon({ count: 2, name: 'x', type: 'folder' })).toBe('🗂')
    expect(chipIcon({ count: 2, name: 'x', type: 'file' })).toBe('🗂')
  })
})
