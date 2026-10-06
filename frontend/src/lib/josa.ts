/** 조사 '로 / 으로' 고르기.
 *
 * 폴더·공간 이름은 사용자가 짓는다. 그 뒤에 조사를 **박아두면** 절반은 틀린 말이 된다 —
 * 실제로 '전체 공간로 파일을 올립니다' 가 화면에 나갔다. '(으)로' 로 피하는 방법도 있지만
 * 그건 공문서 투지 사람이 하는 말이 아니다.
 *
 * 규칙은 **앞 글자의 받침** 하나다:
 *   받침 없음 → 로   (회사로)
 *   ㄹ 받침   → 로   (서울로)
 *   그 외     → 으로 (공간으로, 집으로)
 *
 * 한글이 아니면 **한국어로 읽은 소리**를 따른다. 세어보면 '으로' 가 되는 건 몇 개 안 된다:
 *   숫자 — 0 영(ㅇ) · 3 삼(ㅁ) · 6 육(ㄱ) 셋뿐. 1 일·7 칠·8 팔은 ㄹ 이라 '로'.
 *   영문 — m 엠(ㅁ) · n 엔(ㄴ) 둘뿐. l 엘·r 알은 ㄹ 이라 '로', 나머지는 모음으로 끝난다
 *          (x 는 '엑스', z 는 '제트' — 둘 다 받침 없이 끝난다).
 */

const 으로가되는숫자 = new Set(['0', '3', '6'])
const 으로가되는영문 = new Set(['m', 'n'])

/** 읽을 수 있는 마지막 글자. 이름이 '보고서(최종).' 처럼 끝나면 괄호·점은 건너뛴다. */
function lastReadable(word: string): string | null {
  for (let i = word.length - 1; i >= 0; i--) {
    const c = word[i]
    if (/[0-9A-Za-z가-힣]/.test(c)) return c
  }
  return null
}

/** 이 이름 뒤에 붙일 조사 — '로' 또는 '으로'. 이름 자체는 포함하지 않는다. */
export function ro(word: string | null | undefined): string {
  const c = lastReadable(word ?? '')
  if (c === null) return '로'; // 읽을 글자가 없으면 짧은 쪽이 덜 어색하다

  // 한글 음절 — 종성 인덱스 0=받침없음, 8=ㄹ
  const code = c.charCodeAt(0)
  if (code >= 0xac00 && code <= 0xd7a3) {
    const jong = (code - 0xac00) % 28
    return jong === 0 || jong === 8 ? '로' : '으로'
  }

  if (으로가되는숫자.has(c)) return '으로'
  if (으로가되는영문.has(c.toLowerCase())) return '으로'
  return '로'
}

/** 이 이름 뒤에 붙일 조사 — '을' 또는 '를'. 이름 자체는 포함하지 않는다.
 *
 * '로/으로' 와 달리 규칙이 하나다: **받침이 있으면 을, 없으면 를.** (ㄹ 예외가 없다.)
 *
 * 한글이 아니면 역시 **한국어로 읽은 소리**를 따른다. 여기선 '로/으로' 보다 걸리는 게
 * 많다 — ㄹ 받침도 받침이기 때문이다:
 *   숫자 — 0 영 · 1 일 · 3 삼 · 6 육 · 7 칠 · 8 팔 이 받침으로 끝난다(→ 을).
 *          2 이 · 4 사 · 5 오 · 9 구 는 모음으로 끝난다(→ 를).
 *   영문 — l 엘 · m 엠 · n 엔 · r 알 넷뿐(→ 을). 나머지는 모음으로 끝난다
 *          (x 는 '엑스', z 는 '제트' — 둘 다 받침 없이 끝난다).
 *
 * 파일 이름이라 확장자로 끝나는 일이 많다: '보고서.md' 는 d(디) 라 '를',
 * '그림.png' 는 g(지) 라 '를', '자료.hwp' 는 p(피) 라 '를' 이다.
 */
const 을이되는숫자 = new Set(['0', '1', '3', '6', '7', '8'])
const 을이되는영문 = new Set(['l', 'm', 'n', 'r'])

export function eul(word: string | null | undefined): string {
  const c = lastReadable(word ?? '')
  if (c === null) return '를' // 읽을 글자가 없으면 짧은 쪽이 덜 어색하다

  const code = c.charCodeAt(0)
  if (code >= 0xac00 && code <= 0xd7a3) {
    return (code - 0xac00) % 28 === 0 ? '를' : '을'
  }

  if (을이되는숫자.has(c)) return '을'
  if (을이되는영문.has(c.toLowerCase())) return '을'
  return '를'
}
