import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, ApiError } from './api'

function mockRes(status: number, body: unknown, opts?: { badJson?: boolean }): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: opts?.badJson
      ? () => Promise.reject(new Error('not json'))
      : () => Promise.resolve(body),
  } as unknown as Response
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('api()', () => {
  it('2xx면 파싱된 JSON을 반환한다', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockRes(200, { ok: true, n: 3 })))
    await expect(api('/api/ping')).resolves.toEqual({ ok: true, n: 3 })
  })

  it('Content-Type을 붙이고 호출자의 headers/옵션을 병합한다', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockRes(200, {}))
    vi.stubGlobal('fetch', fetchMock)
    await api('/api/x', { method: 'POST', headers: { 'X-Test': '1' } })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [path, init] = fetchMock.mock.calls[0]
    expect(path).toBe('/api/x')
    expect(init.method).toBe('POST')
    expect(init.headers).toMatchObject({ 'Content-Type': 'application/json', 'X-Test': '1' })
  })

  it('에러 응답이면 서버 detail을 담은 ApiError를 던진다', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockRes(400, { detail: '권한이 없습니다' })))
    const err = (await api('/api/x').catch((e) => e)) as ApiError
    expect(err).toBeInstanceOf(ApiError)
    expect(err.status).toBe(400)
    expect(err.message).toBe('권한이 없습니다')
  })

  it('detail이 없으면 상태코드 기반 기본 메시지로 폴백한다', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockRes(500, { foo: 'bar' })))
    const err = (await api('/api/x').catch((e) => e)) as ApiError
    expect(err).toBeInstanceOf(ApiError)
    expect(err.status).toBe(500)
    expect(err.message).toBe('요청 실패 (500)')
  })

  it('본문이 JSON이 아니어도 기본 메시지로 폴백한다', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockRes(502, null, { badJson: true })))
    const err = (await api('/api/x').catch((e) => e)) as ApiError
    expect(err).toBeInstanceOf(ApiError)
    expect(err.status).toBe(502)
    expect(err.message).toBe('요청 실패 (502)')
  })
})
