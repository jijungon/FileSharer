import { describe, expect, it } from 'vitest'
import { downloadUrlData } from './dragout'
import { NodeInfo } from './files'

const base: NodeInfo = {
  id: 'n1',
  space_id: 's1',
  parent_id: null,
  type: 'file',
  name: '보고서.pdf',
  size: 10,
  mime: 'application/pdf',
  updated_at: null,
}

describe('downloadUrlData', () => {
  it('builds mime:name:url for files', () => {
    expect(downloadUrlData(base, 'https://fs.example')).toBe(
      'application/pdf:보고서.pdf:https://fs.example/api/files/n1',
    )
  })

  it('folders download as tar.gz', () => {
    const folder = { ...base, id: 'n2', type: 'folder' as const, name: '배포', mime: '' }
    expect(downloadUrlData(folder, 'https://fs.example')).toBe(
      'application/gzip:배포.tar.gz:https://fs.example/api/nodes/n2/tar',
    )
  })

  it('strips colon from names (DownloadURL delimiter)', () => {
    const tricky = { ...base, name: 'a:b.txt', mime: 'text/plain' }
    expect(downloadUrlData(tricky, 'https://fs.example')).toContain(':a_b.txt:')
  })
})
