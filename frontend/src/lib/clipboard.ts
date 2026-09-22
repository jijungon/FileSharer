// 클립보드 복사 — navigator.clipboard가 막히거나(권한·비보안 컨텍스트) 미지원인 환경에서도
// 조용히 죽지 않게 try/catch + 레거시(execCommand) 폴백. 성공 여부를 boolean으로 돌려주므로
// 호출부가 '복사됨/실패'를 사용자에게 표시할 수 있다.
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    /* 권한 거부·비보안 컨텍스트 등 — 아래 레거시로 폴백 */
  }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.top = '-1000px'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.focus()
    ta.select()
    const ok = document.execCommand('copy')
    ta.remove()
    return ok
  } catch {
    return false
  }
}
