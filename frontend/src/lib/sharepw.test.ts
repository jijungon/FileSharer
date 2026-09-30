import { describe, expect, it } from 'vitest'
import { shareAuthHeaders } from './sharepw'

/** 헤더를 서버가 읽는 방식 그대로 되돌린다 — base64 → UTF-8 → 첫 ':' 뒤. */
function decode(headers: Record<string, string>): string {
  const raw = atob(headers.Authorization.replace(/^Basic /, ''))
  const bytes = Uint8Array.from(raw, (ch) => ch.charCodeAt(0))
  const text = new TextDecoder().decode(bytes)
  return text.slice(text.indexOf(':') + 1)
}

describe('shareAuthHeaders', () => {
  it('비밀번호가 없으면 헤더를 달지 않는다', () => {
    expect(shareAuthHeaders('')).toEqual({})
  })

  it('영문 비밀번호를 그대로 실어 나른다', () => {
    expect(decode(shareAuthHeaders('share-pw-123'))).toBe('share-pw-123')
  })

  it('한글 비밀번호를 그대로 실어 나른다', () => {
    // 이게 이 파일의 존재 이유다. 예전엔 헤더에 직접 넣어 fetch 가 터졌다.
    expect(decode(shareAuthHeaders('한글비밀번호'))).toBe('한글비밀번호')
  })

  it('이모지·특수문자도 견딘다', () => {
    expect(decode(shareAuthHeaders('🔒열쇠'))).toBe('🔒열쇠')
  })

  it("비밀번호에 ':' 가 들어 있어도 잘리지 않는다", () => {
    // 서버는 **첫** ':' 에서만 자른다. 사용자 이름을 비워 뒀으니 뒤는 통째로 비밀번호다.
    expect(decode(shareAuthHeaders('a:b:c'))).toBe('a:b:c')
  })

  it('헤더 값은 Latin-1 안에 있어야 한다 — 아니면 fetch 가 보내기 전에 터진다', () => {
    const value = shareAuthHeaders('한글비밀번호').Authorization
    expect(value).toMatch(/^Basic [A-Za-z0-9+/]+=*$/)
    // eslint-disable-next-line no-control-regex
    expect(value).not.toMatch(/[^\u0000-ÿ]/)
  })
})
