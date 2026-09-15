import { describe, expect, it } from 'vitest'
import { partitionBySize } from './upload'

const f = (name: string, mb: number) => ({ name, size: mb * 1024 * 1024 })

describe('partitionBySize', () => {
  it('제한 초과 파일을 tooBig로 분리한다', () => {
    const items = [f('a', 100), f('b', 600), f('c', 500), f('big', 501)]
    const { ok, tooBig } = partitionBySize(items, 500, (x) => x.size)
    expect(ok.map((x) => x.name)).toEqual(['a', 'c']) // 500MB 정확히는 통과(초과만 제외)
    expect(tooBig.map((x) => x.name)).toEqual(['b', 'big'])
  })

  it('maxMb<=0 이면 검사하지 않고 모두 통과', () => {
    const items = [f('a', 9999)]
    expect(partitionBySize(items, 0, (x) => x.size).tooBig).toEqual([])
    expect(partitionBySize(items, -1, (x) => x.size).ok).toHaveLength(1)
  })

  it('임의 항목 타입에 size 접근자로 동작(폴더 업로드용 {file})', () => {
    const items = [{ file: f('x', 700) }, { file: f('y', 10) }]
    const { ok, tooBig } = partitionBySize(items, 500, (c) => c.file.size)
    expect(ok).toHaveLength(1)
    expect(tooBig[0].file.name).toBe('x')
  })
})
