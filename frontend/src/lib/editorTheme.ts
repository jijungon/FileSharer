import { EditorView } from '@uiw/react-codemirror'
import type { Theme } from './theme'

/** 편집기(CodeMirror) 색 — **앱의 모든 편집기가 여기서 가져간다.**
 *
 * 예전엔 이 두 테마가 ViewerPanel 안에만 있었다. 그래서 '새 문서' 모달의 편집기는
 * 테마를 안 받고 CodeMirror 기본(흰 바탕)으로 떴는데, 다크 모드의 밝은 글자색은 그대로
 * 물려받아 **흰 바탕에 연한 회색 글씨** — 쓴 글이 안 보였다(사용자가 화면으로 알려줬다).
 * 편집기가 생길 때마다 테마를 따로 챙겨야 하는 구조였던 게 문제라, 한 곳으로 모았다.
 */

// DnX풍 다크 에디터 테마 (near-black base + 골드 커서/활성줄)
export const EDITOR_DARK = EditorView.theme(
  {
    '&': { color: '#dedce4', backgroundColor: '#131315' },
    '.cm-content': { caretColor: '#cba85a', padding: '8px 0' },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: '#cba85a' },
    '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, .cm-content ::selection': {
      backgroundColor: '#3a3427',
    },
    '.cm-gutters': { backgroundColor: '#131315', color: '#57565d', border: 'none' },
    '.cm-activeLine': { backgroundColor: 'rgba(203, 168, 90, 0.045)' },
    '.cm-activeLineGutter': { backgroundColor: 'rgba(203, 168, 90, 0.05)', color: '#cba85a' },
    '.cm-selectionMatch': { backgroundColor: 'rgba(203, 168, 90, 0.14)' },
  },
  { dark: true },
)

// 라이트 모드 에디터 테마 (흰 바탕 + 진한 골드 커서/활성줄, 어두운 글자로 대비 확보)
export const EDITOR_LIGHT = EditorView.theme(
  {
    '&': { color: '#1d1d1f', backgroundColor: '#ffffff' },
    '.cm-content': { caretColor: '#9a7526', padding: '8px 0' },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: '#9a7526' },
    '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, .cm-content ::selection': {
      backgroundColor: '#ece0c4',
    },
    '.cm-gutters': { backgroundColor: '#ffffff', color: '#adacb4', border: 'none' },
    '.cm-activeLine': { backgroundColor: 'rgba(154, 117, 38, 0.06)' },
    '.cm-activeLineGutter': { backgroundColor: 'rgba(154, 117, 38, 0.09)', color: '#9a7526' },
    '.cm-selectionMatch': { backgroundColor: 'rgba(154, 117, 38, 0.18)' },
  },
  { dark: false },
)

/** 앱 테마(라이트/다크)에 맞는 편집기 테마. */
export function editorThemeFor(theme: Theme) {
  return theme === 'light' ? EDITOR_LIGHT : EDITOR_DARK
}
