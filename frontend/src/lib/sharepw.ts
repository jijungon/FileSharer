/** 공유 비밀번호를 HTTP 헤더에 실어 보내는 방법.
 *
 * **HTTP 헤더 값은 Latin-1 만 담을 수 있다.** 한글 비밀번호를 `X-Share-Password` 에
 * 그대로 넣으면 브라우저가 요청을 보내기도 **전에** TypeError 를 던진다
 * ("String contains non ISO-8859-1 code point"). 잡는 곳이 없으면 '열기' 버튼이
 * 아무 반응 없이 죽은 것처럼 보인다 — 에러도, 요청도 없다.
 *
 * curl 로 억지로 밀어 넣어도 마찬가지다. 서버는 헤더를 Latin-1 로 읽으므로 깨진 값을
 * 받아 401 을 준다. 즉 이 헤더로는 한글 비밀번호를 **애초에 전달할 수 없다.**
 *
 * 그래서 서버가 이미 받아주는 Basic 인증으로 감싼다. 비밀번호를 UTF-8 바이트로 만든 뒤
 * base64 로 옮기므로 어떤 문자든 헤더를 안전하게 지나간다. 공유 팝오버가 안내하는
 * `curl -u :'<비밀번호>'` 와 **같은 경로**다 (backend/app/services/shares.py 의
 * check_password 가 X-Share-Password 와 Basic 을 모두 본다).
 */
export function shareAuthHeaders(password: string): Record<string, string> {
  if (!password) return {}
  // 사용자 이름은 비우고 비밀번호만 쓴다 (`:<비밀번호>`) — 서버가 첫 ':' 뒤를 읽는다.
  const bytes = new TextEncoder().encode(`:${password}`)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return { Authorization: `Basic ${btoa(binary)}` }
}
