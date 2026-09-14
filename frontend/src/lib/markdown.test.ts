import { describe, expect, it } from 'vitest'
import { NodeInfo } from './files'
import { isAudio, isHtml, isImage, isMarkdown, isPdf, isTextFile, isVideo } from './markdown'

const node = (name: string, mime = ''): NodeInfo => ({
  id: 'x',
  space_id: 's',
  parent_id: null,
  type: 'file',
  name,
  size: 1,
  mime,
  created_at: null,
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

describe('isVideo / isAudio / isHtml', () => {
  it('detects video by mime or extension', () => {
    expect(isVideo(node('클립.mp4', 'video/mp4'))).toBe(true)
    expect(isVideo(node('영상.webm'))).toBe(true)
    expect(isVideo(node('노래.mp3'))).toBe(false)
  })

  it('detects audio by mime or extension', () => {
    expect(isAudio(node('노래.mp3', 'audio/mpeg'))).toBe(true)
    expect(isAudio(node('녹음.m4a'))).toBe(true)
    expect(isAudio(node('클립.mp4'))).toBe(false)
  })

  it('detects html — and it wins over the text editor', () => {
    expect(isHtml(node('page.html', 'text/html'))).toBe(true)
    expect(isHtml(node('리포트.htm'))).toBe(true)
    // text/html도 텍스트지만 뷰어는 isHtml을 먼저 확인해 렌더한다
    expect(isTextFile(node('page.html', 'text/html'))).toBe(true)
    expect(isHtml(node('노트.md'))).toBe(false)
  })
})
