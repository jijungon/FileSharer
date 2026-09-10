import { FormEvent, useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api } from '../lib/api'

const GOOGLE_ICON = (
  <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
    <path
      fill="#fff"
      d="M44.5 20H24v8.5h11.8C34.7 33.9 30.1 37 24 37c-7.2 0-13-5.8-13-13s5.8-13 13-13c3.1 0 5.9 1.1 8.1 2.9l6.4-6.4C34.6 4.1 29.6 2 24 2 11.8 2 2 11.8 2 24s9.8 22 22 22c11 0 21-8 21-22 0-1.3-.2-2.7-.5-4z"
    />
  </svg>
)

const CALLBACK_ERRORS: Record<string, string> = {
  forbidden_domain: '사내 구글 계정으로만 로그인할 수 있습니다.',
  disabled: '비활성화된 계정입니다. 관리자에게 문의하세요.',
  oauth_failed: '구글 로그인에 실패했습니다. 다시 시도해 주세요.',
}

export default function Login() {
  const [params] = useSearchParams()
  const [googleEnabled, setGoogleEnabled] = useState(true)
  const [showLocal, setShowLocal] = useState(false)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState(() => CALLBACK_ERRORS[params.get('error') ?? ''] ?? '')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    api<{ google_enabled: boolean }>('/api/auth/config')
      .then((cfg) => setGoogleEnabled(cfg.google_enabled))
      .catch(() => setGoogleEnabled(false))
  }, [])

  async function submitLocal(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      await api('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      })
      window.location.href = '/files'
    } catch (err) {
      setError(err instanceof Error ? err.message : '로그인에 실패했습니다.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="login-page">
      <div className="login-card">
        <h1>FileSharer</h1>
        <p className="tagline">사내 파일 공유 · MD 뷰어</p>

        {googleEnabled ? (
          <a href="/api/auth/google">
            <button className="btn-primary login-google" type="button">
              {GOOGLE_ICON} Google로 로그인
            </button>
          </a>
        ) : (
          <p style={{ color: 'var(--ink-muted-48)', fontSize: 14 }}>
            구글 로그인이 아직 설정되지 않았습니다.
          </p>
        )}

        <div className="login-divider">또는</div>

        {showLocal ? (
          <form className="login-local" onSubmit={submitLocal}>
            <input
              type="email"
              placeholder="이메일"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="username"
              required
            />
            <input
              type="password"
              placeholder="비밀번호"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
            <button className="btn-ghost" type="submit" disabled={busy}>
              로컬 계정으로 로그인
            </button>
          </form>
        ) : (
          <button className="login-local-toggle" type="button" onClick={() => setShowLocal(true)}>
            로컬 계정으로 로그인 (관리자·비상용)
          </button>
        )}
        <div className="login-error">{error}</div>
      </div>
    </div>
  )
}
