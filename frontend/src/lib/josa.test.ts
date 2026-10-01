import { describe, expect, it } from 'vitest'
import { ro } from './josa'

describe('ro — 조사 로/으로', () => {
  it('받침 없는 한글은 로', () => {
    for (const w of ['회사', '서버', '내 자료', '가']) expect(ro(w)).toBe('로')
  })

  it('ㄹ 받침은 로 — 받침이 있어도 ㄹ 만은 예외다', () => {
    for (const w of ['서울', '하늘', '파일']) expect(ro(w)).toBe('로')
  })

  it('그 밖의 받침은 으로', () => {
    // 화면에 '전체 공간로' 로 나갔던 바로 그 경우
    expect(ro('전체 공간')).toBe('으로')
    expect(ro('내 공간')).toBe('으로')
    for (const w of ['집', '문서함', '작업중']) expect(ro(w)).toBe('으로')
    // 받침이 '있어 보이는' 끝글자에 속지 말 것 — '드'·'트'는 받침이 없다
    for (const w of ['다운로드', '프로젝트']) expect(ro(w)).toBe('로')
  })

  it('숫자는 읽은 소리를 따른다 — 영·삼·육만 으로', () => {
    expect(ro('v1.0')).toBe('으로'); // 영
    expect(ro('MP3')).toBe('으로'); // 삼
    expect(ro('로그6')).toBe('으로'); // 육
    expect(ro('2025')).toBe('로'); // 오
    expect(ro('단계1')).toBe('로'); // 일 — ㄹ
    expect(ro('7')).toBe('로'); // 칠 — ㄹ
    expect(ro('8')).toBe('로'); // 팔 — ㄹ
  })

  it('영문자도 읽은 소리를 따른다 — m·n 만 으로', () => {
    expect(ro('TEAM')).toBe('으로'); // 엠
    expect(ro('admin')).toBe('으로'); // 엔
    expect(ro('IDP')).toBe('로'); // 피
    expect(ro('TOOL')).toBe('로'); // 엘 — ㄹ
    expect(ro('SERVER')).toBe('로'); // 알 — ㄹ
    expect(ro('z')).toBe('로'); // 제트
    expect(ro('UNIX')).toBe('로'); // 엑스
    expect(ro('Docker')).toBe('로'); // 알
  })

  it('끝에 붙은 괄호·점·공백은 건너뛰고 읽는다', () => {
    expect(ro('테스트문서 1 (2).md')).toBe('로'); // 디
    expect(ro('보고서(최종)')).toBe('으로'); // 종
    expect(ro('공간   ')).toBe('으로')
  })

  it('읽을 글자가 없거나 비어 있으면 로', () => {
    for (const w of ['', '   ', '—', null, undefined]) expect(ro(w)).toBe('로')
  })
})
