/** 앱 테마(다크 기본 ↔ 라이트).
 *
 * `<html data-theme>` 가 단일 진실이고 localStorage('fs:theme')에 기억한다.
 * 최초 적용은 index.html 의 인라인 스크립트가 한다(첫 페인트 깜빡임 방지).
 *
 * 토글이 Files 화면에만 있던 탓에 공유 페이지(/s/<token>)에서는 모드를 바꿀 수 없었고,
 * 테마를 읽는 로직도 컴포넌트마다 복붙돼 있었다. 여기로 모아 한 곳에서 관리한다.
 */
import { useEffect, useState } from 'react'

export type Theme = 'light' | 'dark'

export function getTheme(): Theme {
  if (typeof document === 'undefined') return 'dark'
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'
}

export function setTheme(next: Theme): void {
  document.documentElement.dataset.theme = next
  try {
    localStorage.setItem('fs:theme', next)
  } catch {
    /* localStorage 불가(사생활 보호 모드 등) — 이번 세션 동안만 적용된다 */
  }
}

export function toggleTheme(): Theme {
  const next: Theme = getTheme() === 'dark' ? 'light' : 'dark'
  setTheme(next)
  return next
}

/** 현재 테마를 구독한다 — 어디서 토글하든 `<html data-theme>` 변화를 보고 따라간다. */
export function useAppTheme(): Theme {
  const [theme, setThemeState] = useState<Theme>(getTheme)
  useEffect(() => {
    const el = document.documentElement
    const obs = new MutationObserver(() => setThemeState(getTheme()))
    obs.observe(el, { attributes: true, attributeFilter: ['data-theme'] })
    return () => obs.disconnect()
  }, [])
  return theme
}
