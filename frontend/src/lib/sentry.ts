/** 에러 추적(Sentry) — 사용자가 만난 오류를 우리가 알게 한다.
 *
 * DSN은 **서버가 `/api/health` 로 알려준다**. 번들에 박으면 환경마다 다시 빌드해야 하고,
 * 오늘 버전 뱃지에서 겪었듯 파일명이 그대로인 배포에서 CDN이 옛 값을 내줄 수 있다.
 *
 * SDK는 **DSN이 있을 때만** 내려받는다(동적 import). 꺼져 있으면 번들 크기가 늘지 않는다.
 *
 * **보내기 전에 지우는 것**: 공유 페이지 주소가 `/s/<토큰>` 이고 그 토큰이 곧 파일 접근
 * 권한이다. 에러 리포트에 그대로 들어가면 리포트를 본 사람이 파일을 받을 수 있다.
 */
type SentrySdk = typeof import('@sentry/react')

let sdk: SentrySdk | null = null

const SHARE_URL = /(\/s\/)[A-Za-z0-9_-]{16,}/g
const API_TOKEN = /\bfsk_[A-Za-z0-9_.-]+/g

/** 문자열에서 '그대로 쓸 수 있는 열쇠'를 지운다(백엔드 observability.py 와 같은 규칙). */
export function redact(text: string): string {
  return text.replace(SHARE_URL, '$1<share-token>').replace(API_TOKEN, '<api-token>')
}

/** 이벤트를 통째로 훑어 지운다 — 한 군데만 놓쳐도 토큰이 그대로 나간다. */
export function scrub<T>(value: T): T {
  if (typeof value === 'string') return redact(value) as unknown as T
  if (Array.isArray(value)) return value.map((item) => scrub(item)) as unknown as T
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) out[key] = scrub(item)
    return out as unknown as T
  }
  return value
}

interface SentryConfig {
  sentry_dsn?: string
  environment?: string
  version?: string
  build?: string
}

/** 서버가 준 설정으로 켠다. DSN이 없으면 아무것도 하지 않는다(SDK도 안 받아온다). */
export async function initSentry(config: SentryConfig): Promise<boolean> {
  if (!config.sentry_dsn || sdk) return false
  try {
    const mod = await import('@sentry/react')
    const build = (config.build ?? '').replace('#', '')
    mod.init({
      dsn: config.sentry_dsn,
      environment: config.environment || 'dev',
      // 백엔드와 같은 형식이어야 한 사건의 앞뒤가 이어진다 (v1.0.0+153)
      release: `${config.version || 'dev'}${build ? `+${build}` : ''}`,
      // 브라우저 SDK는 PII(IP·쿠키)를 기본으로 보내지 않는다 — 켜지 않으면 그대로 꺼져 있다.
      // 진짜 보호는 아래 beforeSend 의 지우기다(URL 안의 공유 토큰은 PII 설정과 무관하다).
      tracesSampleRate: 0, // 성능 추적은 끔(무료 한도 보호)
      beforeSend: (event) => scrub(event),
    })
    sdk = mod
    return true
  } catch {
    return false // 추적기를 못 켰다고 앱이 멈추면 본말전도다
  }
}

/** 잡은 예외를 보낸다. 꺼져 있으면 아무 일도 하지 않는다. */
export function captureError(error: unknown, context?: Record<string, unknown>): void {
  try {
    sdk?.captureException(error, context ? { extra: scrub(context) } : undefined)
  } catch {
    /* 추적 실패가 화면을 깨뜨리면 안 된다 */
  }
}
