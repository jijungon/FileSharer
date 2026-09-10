import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api, ApiError, Me, SpaceInfo } from '../lib/api'

export default function Files() {
  const navigate = useNavigate()
  const [me, setMe] = useState<Me | null>(null)
  const [spaces, setSpaces] = useState<SpaceInfo[]>([])

  useEffect(() => {
    Promise.all([api<Me>('/api/me'), api<SpaceInfo[]>('/api/spaces')])
      .then(([meRes, spacesRes]) => {
        setMe(meRes)
        setSpaces(spacesRes)
      })
      .catch((err) => {
        if (err instanceof ApiError && err.status === 401) navigate('/login', { replace: true })
      })
  }, [navigate])

  async function logout() {
    await api('/api/auth/logout', { method: 'POST' })
    navigate('/login', { replace: true })
  }

  if (!me) return null

  return (
    <div style={{ padding: 'var(--sp-xl)' }}>
      <header
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 'var(--sp-lg)',
        }}
      >
        <h2>FileSharer</h2>
        <div style={{ display: 'flex', gap: 'var(--sp-sm)', alignItems: 'center' }}>
          <span style={{ color: 'var(--ink-muted-48)', fontSize: 14 }}>{me.email}</span>
          {me.role === 'admin' && (
            <Link to="/admin">
              <button className="btn-utility">관리</button>
            </Link>
          )}
          <button className="btn-utility" onClick={logout}>
            로그아웃
          </button>
        </div>
      </header>
      <p style={{ color: 'var(--ink-muted-48)' }}>
        파일 브라우저는 다음 단계에서 열립니다. 접근 가능한 공간:
      </p>
      <ul>
        {spaces.map((s) => (
          <li key={s.id}>{s.name}</li>
        ))}
      </ul>
    </div>
  )
}
