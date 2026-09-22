// 전역 에러 가시화 — 조용히 죽던 오류(처리 안 된 promise rejection, 런타임 에러)를
// 화면 토스트로 띄우고 콘솔에 남긴다. React 밖(async)에서도 동작하도록 순수 DOM 토스트로 구현.
let toastTimer: number | undefined

// 사용자에게 짧은 토스트를 띄운다(클릭·6초 후 사라짐). 의도적 실패 안내에도 재사용.
export function showToast(message: string, kind: 'error' | 'info' = 'error'): void {
  try {
    let el = document.getElementById('app-toast')
    if (!el) {
      el = document.createElement('div')
      el.id = 'app-toast'
      el.className = 'app-toast'
      el.addEventListener('click', () => el && el.remove())
      document.body.appendChild(el)
    }
    el.dataset.kind = kind
    el.textContent = message
    window.clearTimeout(toastTimer)
    toastTimer = window.setTimeout(() => el && el.remove(), 6000)
  } catch {
    /* DOM 불가 환경 무시 */
  }
}

// 앱 부팅 시 1회 설치. 전역 미처리 오류를 토스트+콘솔로 노출한다.
export function installGlobalErrorHandlers(): void {
  window.addEventListener('unhandledrejection', (e) => {
    console.error('[unhandledrejection]', e.reason)
    showToast('처리되지 않은 오류가 발생했어요. 새로고침하거나 잠시 후 다시 시도해 주세요.')
  })
  window.addEventListener('error', (e) => {
    // 스크립트/런타임 에러만(이미지 등 리소스 로드 실패는 e.error가 없어 자연히 제외)
    if (e.error) {
      console.error('[error]', e.error)
      showToast('오류가 발생했어요. 새로고침하거나 잠시 후 다시 시도해 주세요.')
    }
  })
}
