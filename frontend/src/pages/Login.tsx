import { FormEvent, useState } from 'react'

const GOOGLE_ICON = (
  <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
    <path
      fill="#fff"
      d="M44.5 20H24v8.5h11.8C34.7 33.9 30.1 37 24 37c-7.2 0-13-5.8-13-13s5.8-13 13-13c3.1 0 5.9 1.1 8.1 2.9l6.4-6.4C34.6 4.1 29.6 2 24 2 11.8 2 2 11.8 2 24s9.8 22 22 22c11 0 21-8 21-22 0-1.3-.2-2.7-.5-4z"
    />
  </svg>
)

export default function Login() {
  const [showLocal, setShowLocal] = useState(false)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submitLocal(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      })
      if (res.ok) {
        window.location.href = '/files'
      } else {
        const body = await res.json().catch(() => null)
        setError(body?.detail ?? '로그인에 실패했습니다.')
      }
    } catch {
      setError('서버에 연결할 수 없습니다.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="login-page">
      <div className="login-card">
        <h1>FileSharer</h1>
        <p className="tagline">사내 파일 공유 · MD 뷰어</p>

        <a href="/api/auth/google">
          <button className="btn-primary login-google" type="button">
            {GOOGLE_ICON} Google로 로그인
          </button>
        </a>

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
            <div className="login-error">{error}</div>
          </form>
        ) : (
          <button className="login-local-toggle" type="button" onClick={() => setShowLocal(true)}>
            로컬 계정으로 로그인 (관리자·비상용)
          </button>
        )}
      </div>
    </div>
  )
}
