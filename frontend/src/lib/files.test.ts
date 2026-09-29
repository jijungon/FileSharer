import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BUNDLE_MAX, bundleRequest, uploadFile } from './files'

// XMLHttpRequest 대역. open/send를 기록하고, 테스트가 onload/onerror/progress를 직접 구동한다.
class FakeXHR {
  static instances: FakeXHR[] = []
  method = ''
  url = ''
  responseType = ''
  status = 0
  response: unknown = null
  sent: unknown = null
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  upload: { onprogress: ((e: ProgressEvent) => void) | null } = { onprogress: null }

  constructor() {
    FakeXHR.instances.push(this)
  }
  open(method: string, url: string) {
    this.method = method
    this.url = url
  }
  send(body: unknown) {
    this.sent = body
  }
  static last() {
    return FakeXHR.instances[FakeXHR.instances.length - 1]
  }
}

beforeEach(() => {
  FakeXHR.instances = []
  vi.stubGlobal('XMLHttpRequest', FakeXHR as unknown as typeof XMLHttpRequest)
})
afterEach(() => {
  vi.unstubAllGlobals()
})

const file = () => new File(['data'], 'a.txt', { type: 'text/plain' })

describe('uploadFile', () => {
  it('폴더 안이면 /nodes/{parentId}/files로 POST', () => {
    uploadFile({ spaceId: 's1', parentId: 'p9' }, file())
    const xhr = FakeXHR.last()
    expect(xhr.method).toBe('POST')
    expect(xhr.url).toBe('/api/nodes/p9/files')
  })

  it('공간 루트면 /spaces/{spaceId}/files로 POST', () => {
    uploadFile({ spaceId: 's1', parentId: null }, file())
    expect(FakeXHR.last().url).toBe('/api/spaces/s1/files')
  })

  it('rel_path를 주면 FormData에 담고, 없으면 담지 않는다', () => {
    uploadFile({ spaceId: 's1', parentId: null }, file(), 'dir/sub/a.txt')
    const withPath = FakeXHR.last().sent as FormData
    expect(withPath.get('rel_path')).toBe('dir/sub/a.txt')
    expect((withPath.get('file') as File).name).toBe('a.txt')

    uploadFile({ spaceId: 's1', parentId: null }, file())
    expect((FakeXHR.last().sent as FormData).get('rel_path')).toBeNull()
  })

  it('2xx면 응답 노드로 resolve', async () => {
    const p = uploadFile({ spaceId: 's1', parentId: null }, file())
    const xhr = FakeXHR.last()
    xhr.status = 201
    xhr.response = { id: 'n1', name: 'a.txt' }
    xhr.onload?.()
    await expect(p).resolves.toMatchObject({ id: 'n1', name: 'a.txt' })
  })

  it('HTTP 에러면 서버 detail로 reject', async () => {
    const p = uploadFile({ spaceId: 's1', parentId: null }, file())
    const xhr = FakeXHR.last()
    xhr.status = 413
    xhr.response = { detail: '너무 큽니다' }
    xhr.onload?.()
    await expect(p).rejects.toThrow('너무 큽니다')
  })

  it('detail 없는 HTTP 에러는 상태코드 기본 메시지로 reject', async () => {
    const p = uploadFile({ spaceId: 's1', parentId: null }, file())
    const xhr = FakeXHR.last()
    xhr.status = 500
    xhr.response = null
    xhr.onload?.()
    await expect(p).rejects.toThrow('업로드 실패 (500)')
  })

  it('네트워크 에러(onerror)는 네트워크 메시지로 reject', async () => {
    const p = uploadFile({ spaceId: 's1', parentId: null }, file())
    FakeXHR.last().onerror?.()
    await expect(p).rejects.toThrow('업로드 실패 (네트워크)')
  })

  it('upload.onprogress(lengthComputable)면 onProgress로 loaded/total 전달', () => {
    const onProgress = vi.fn()
    uploadFile({ spaceId: 's1', parentId: null }, file(), undefined, onProgress)
    const xhr = FakeXHR.last()
    xhr.upload.onprogress?.({ lengthComputable: true, loaded: 40, total: 100 } as ProgressEvent)
    xhr.upload.onprogress?.({ lengthComputable: false, loaded: 0, total: 0 } as ProgressEvent)
    expect(onProgress).toHaveBeenCalledTimes(1)
    expect(onProgress).toHaveBeenCalledWith(40, 100)
  })
})

describe('bundleRequest', () => {
  // 링크로 받는 방식이라 서버가 에러를 주면 브라우저가 그 JSON 페이지로 화면을 통째로
  // 옮겨 버린다. 그래서 '보낼 수 있는지'를 보내기 전에 여기서 판단한다.
  it('고른 것들을 id 질의문자열로 엮는다', () => {
    const r = bundleRequest(['a', 'b'])
    expect(r).toEqual({ url: '/api/nodes/bundle?id=a&id=b' })
  })

  it('id를 인코딩한다', () => {
    const r = bundleRequest(['a b&c'])
    expect(r).toEqual({ url: '/api/nodes/bundle?id=a%20b%26c' })
  })

  it('상한을 넘으면 주소 대신 이유를 준다', () => {
    const r = bundleRequest(Array.from({ length: BUNDLE_MAX + 1 }, (_, i) => `n${i}`))
    expect(r).toHaveProperty('error')
    expect('error' in r && r.error).toContain(String(BUNDLE_MAX))
  })

  it('상한 딱 맞으면 받아준다 (경계에서 한 칸 어긋나지 않게)', () => {
    const r = bundleRequest(Array.from({ length: BUNDLE_MAX }, (_, i) => `n${i}`))
    expect(r).toHaveProperty('url')
  })

  it('빈 선택은 이유를 준다', () => {
    expect(bundleRequest([])).toHaveProperty('error')
  })

  it('상한은 서버(BUNDLE_MAX)와 같아야 한다', () => {
    // backend/app/api/nodes.py 의 BUNDLE_MAX. 갈라지면 화면이 통과시킨 요청을 서버가 거절한다.
    expect(BUNDLE_MAX).toBe(200)
  })
})
