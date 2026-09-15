import { describe, expect, it } from 'vitest'
import {
  dropUpload,
  dropUploads,
  markUploadDone,
  partitionBySize,
  percent,
  runWithConcurrency,
  setProgress,
  uploadSummary,
  UploadItem,
} from './upload'

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

describe('업로드 진행 상태 헬퍼', () => {
  const base: UploadItem[] = [
    { id: 'a', name: 'a.txt', loaded: 0, total: 100 },
    { id: 'b', name: 'b.txt', loaded: 10, total: 200 },
  ]

  it('setProgress는 해당 id만 갱신(불변)', () => {
    const next = setProgress(base, 'a', 50, 100)
    expect(next[0]).toEqual({ id: 'a', name: 'a.txt', loaded: 50, total: 100 })
    expect(next[1]).toBe(base[1]) // 나머지는 그대로
    expect(next).not.toBe(base)
    expect(setProgress(base, 'zzz', 1, 1)).toEqual(base) // 없는 id는 무변화
  })

  it('dropUpload는 해당 id 제거', () => {
    expect(dropUpload(base, 'a').map((u) => u.id)).toEqual(['b'])
  })

  it('dropUploads는 주어진 id들을 한 번에 제거', () => {
    const list: UploadItem[] = [...base, { id: 'c', name: 'c', loaded: 0, total: 1 }]
    expect(dropUploads(list, new Set(['a', 'c'])).map((u) => u.id)).toEqual(['b'])
  })

  it('markUploadDone은 성공 시 loaded=total로 채우고 done 표시', () => {
    const next = markUploadDone(base, 'b')
    expect(next[1]).toMatchObject({ id: 'b', done: true, error: false, loaded: 200, total: 200 })
  })

  it('markUploadDone(error)은 error 표시하고 loaded는 그대로', () => {
    const next = markUploadDone(base, 'b', true)
    expect(next[1]).toMatchObject({ id: 'b', done: true, error: true, loaded: 10 })
  })

  it('percent는 0~100 정수, total 0이면 0', () => {
    expect(percent({ loaded: 50, total: 200 })).toBe(25)
    expect(percent({ loaded: 999, total: 100 })).toBe(100) // 상한
    expect(percent({ loaded: 5, total: 0 })).toBe(0)
  })
})

describe('uploadSummary', () => {
  it('전체/완료/실패 개수와 바이트 기반 전체 퍼센트', () => {
    const list: UploadItem[] = [
      { id: 'a', name: 'a', loaded: 100, total: 100, done: true },
      { id: 'b', name: 'b', loaded: 50, total: 100 },
      { id: 'c', name: 'c', loaded: 20, total: 200, done: true, error: true },
    ]
    const s = uploadSummary(list)
    expect(s.total).toBe(3)
    expect(s.done).toBe(1) // 성공만
    expect(s.failed).toBe(1)
    // loaded: a=100(완료→total), b=50, c=20 → 170 / (100+100+200=400) = 42.5 → 43
    expect(s.percent).toBe(43)
  })

  it('빈 목록은 0', () => {
    expect(uploadSummary([])).toEqual({ total: 0, done: 0, failed: 0, percent: 0 })
  })
})

describe('runWithConcurrency', () => {
  it('모든 항목을 처리하고, 동시 실행이 limit을 넘지 않는다', async () => {
    const items = Array.from({ length: 7 }, (_, i) => i)
    const processed: number[] = []
    let active = 0
    let peak = 0
    await runWithConcurrency(items, 3, async (n) => {
      active += 1
      peak = Math.max(peak, active)
      await new Promise((r) => setTimeout(r, 5))
      processed.push(n)
      active -= 1
    })
    expect(processed.sort((x, y) => x - y)).toEqual(items)
    expect(peak).toBeLessThanOrEqual(3)
    expect(peak).toBeGreaterThan(1) // 실제로 병렬 실행됐다
  })

  it('항목이 limit보다 적으면 항목 수만큼만 동시에', async () => {
    let peak = 0
    let active = 0
    await runWithConcurrency([1, 2], 5, async () => {
      active += 1
      peak = Math.max(peak, active)
      await new Promise((r) => setTimeout(r, 5))
      active -= 1
    })
    expect(peak).toBe(2)
  })
})
