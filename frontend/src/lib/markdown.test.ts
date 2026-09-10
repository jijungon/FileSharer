import { describe, expect, it } from 'vitest'
import { NodeInfo } from './files'
import { isImage, isMarkdown, isPdf, isTextFile } from './markdown'

const node = (name: string, mime = ''): NodeInfo => ({
  id: 'x',
  space_id: 's',
  parent_id: null,
  type: 'file',
  name,
  size: 1,
  mime,
  updated_at: null,
})

describe('isTextFile / isMarkdown', () => {
  it('detects markdown and text extensions', () => {
    expect(isTextFile(node('노트.md'))).toBe(true)
    expect(isMarkdown(node('노트.md'))).toBe(true)
    expect(isTextFile(node('config.yaml'))).toBe(true)
    expect(isMarkdown(node('config.yaml'))).toBe(false)
  })

  it('falls back to text/* mime', () => {
    expect(isTextFile(node('unknownfile', 'text/plain'))).toBe(true)
  })

  it('rejects binaries and folders', () => {
    expect(isTextFile(node('사진.png', 'image/png'))).toBe(false)
    expect(isTextFile({ ...node('폴더'), type: 'folder' })).toBe(false)
  })
})

describe('isImage / isPdf', () => {
  it('detects images by mime or extension', () => {
    expect(isImage(node('사진.png', 'image/png'))).toBe(true)
    expect(isImage(node('cap.webp'))).toBe(true)
    expect(isImage(node('문서.pdf', 'application/pdf'))).toBe(false)
  })

  it('detects pdf', () => {
    expect(isPdf(node('문서.pdf', 'application/pdf'))).toBe(true)
    expect(isPdf(node('스캔.pdf'))).toBe(true)
    expect(isPdf(node('노트.md'))).toBe(false)
  })
})
