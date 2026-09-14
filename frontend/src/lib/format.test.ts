import { describe, expect, it } from 'vitest'
import { formatBytes, formatDateTime, normalizeFileName } from './format'

describe('formatBytes', () => {
  it('formats byte ranges', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB')
    expect(formatBytes(5 * 1024 ** 3)).toBe('5.0 GB')
  })

  it('rejects invalid input', () => {
    expect(formatBytes(-1)).toBe('-')
    expect(formatBytes(Number.NaN)).toBe('-')
  })
})

describe('normalizeFileName', () => {
  it('converts NFD hangul to NFC', () => {
    const nfd = '한글파일.md'.normalize('NFD')
    expect(nfd).not.toBe('한글파일.md')
    expect(normalizeFileName(nfd)).toBe('한글파일.md')
  })
})

describe('formatDateTime', () => {
  it('formats naive-UTC iso to local YYYY-MM-DD HH:mm', () => {
    // 입력은 서버의 naive UTC. 로컬 타임존에 의존하지 않도록 형식만 검증
    expect(formatDateTime('2026-09-14T01:05:00')).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
  })
  it('handles null/invalid', () => {
    expect(formatDateTime(null)).toBe('—')
    expect(formatDateTime('nope')).toBe('—')
  })
})
