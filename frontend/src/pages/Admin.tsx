import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api, ApiError, Me } from '../lib/api'

interface AdminUser {
  id: string
  email: string
  name: string
  role: 'admin' | 'member'
  disabled: boolean
  local_login: boolean
}

interface AdminTeam {
  id: string
  name: string
  members: { id: string; email: string; name: string }[]
}

export default function Admin() {
  const navigate = useNavigate()
  const [tab, setTab] = useState<'users' | 'teams'>('users')
  const [users, setUsers] = useState<AdminUser[]>([])
  const [teams, setTeams] = useState<AdminTeam[]>([])
  const [error, setError] = useState('')

  const reload = useCallback(async () => {
    const [u, t] = await Promise.all([
      api<AdminUser[]>('/api/users'),
      api<AdminTeam[]>('/api/teams'),
    ])
    setUsers(u)
    setTeams(t)
  }, [])

  useEffect(() => {
    api<Me>('/api/me')
      .then((me) => {
        if (me.role !== 'admin') navigate('/files', { replace: true })
        else return reload()
      })
      .catch((err) => {
        if (err instanceof ApiError && err.status === 401) navigate('/login', { replace: true })
      })
  }, [navigate, reload])

  async function run(action: () => Promise<unknown>) {
    setError('')
    try {
      await action()
      await reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : '요청에 실패했습니다')
    }
  }

  return (
    <div style={{ maxWidth: 980, margin: '0 auto', padding: 'var(--sp-xl)' }}>
      <header
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 'var(--sp-lg)',
        }}
      >
        <h2>관리</h2>
        <Link to="/files">← 파일로 돌아가기</Link>
      </header>

      <nav style={{ display: 'flex', gap: 'var(--sp-xs)', marginBottom: 'var(--sp-lg)' }}>
        <button
          className={tab === 'users' ? 'btn-primary' : 'btn-ghost'}
          onClick={() => setTab('users')}
        >
          사용자
        </button>
        <button
          className={tab === 'teams' ? 'btn-primary' : 'btn-ghost'}
          onClick={() => setTab('teams')}
        >
          팀
        </button>
      </nav>

      {error && <p style={{ color: '#d70015', fontSize: 14 }}>{error}</p>}

      {tab === 'users' ? (
        <UsersTab users={users} onAction={run} />
      ) : (
        <TeamsTab teams={teams} users={users} onAction={run} />
      )}
    </div>
  )
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <section
      style={{
        background: 'var(--canvas)',
        border: '1px solid var(--hairline)',
        borderRadius: 'var(--radius-lg)',
        padding: 'var(--sp-lg)',
        marginBottom: 'var(--sp-lg)',
      }}
    >
      {children}
    </section>
  )
}

function UsersTab({
  users,
  onAction,
}: {
  users: AdminUser[]
  onAction: (a: () => Promise<unknown>) => void
}) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')

  return (
    <>
      <Card>
        <h3 style={{ fontSize: 21, marginBottom: 'var(--sp-sm)' }}>사용자 초대</h3>
        <p style={{ color: 'var(--ink-muted-48)', fontSize: 14, marginTop: 0 }}>
          사내 구글 계정은 초대 없이 첫 로그인 시 자동 생성됩니다. 초대는 로컬(비상용) 계정 전용.
        </p>
        <form
          style={{ display: 'flex', gap: 'var(--sp-sm)', flexWrap: 'wrap' }}
          onSubmit={(e) => {
            e.preventDefault()
            onAction(() =>
              api('/api/users', {
                method: 'POST',
                body: JSON.stringify({ email, password: password || null }),
              }),
            )
            setEmail('')
            setPassword('')
          }}
        >
          <input
            style={inputStyle}
            type="email"
            placeholder="이메일"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
          <input
            style={inputStyle}
            type="password"
            placeholder="비밀번호 (로컬 로그인용, 선택)"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <button className="btn-primary" type="submit">
            초대
          </button>
        </form>
      </Card>

      <Card>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 15 }}>
          <thead>
            <tr style={{ textAlign: 'left', color: 'var(--ink-muted-48)' }}>
              <th style={thStyle}>이메일</th>
              <th style={thStyle}>역할</th>
              <th style={thStyle}>상태</th>
              <th style={thStyle}></th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} style={{ borderTop: '1px solid var(--divider-soft)' }}>
                <td style={tdStyle}>
                  {u.email}
                  {u.local_login && (
                    <span style={{ color: 'var(--ink-muted-48)', fontSize: 12 }}> · 로컬</span>
                  )}
                </td>
                <td style={tdStyle}>
                  <select
                    value={u.role}
                    onChange={(e) =>
                      onAction(() =>
                        api(`/api/users/${u.id}`, {
                          method: 'PATCH',
                          body: JSON.stringify({ role: e.target.value }),
                        }),
                      )
                    }
                  >
                    <option value="member">member</option>
                    <option value="admin">admin</option>
                  </select>
                </td>
                <td style={tdStyle}>{u.disabled ? '비활성' : '활성'}</td>
                <td style={{ ...tdStyle, textAlign: 'right' }}>
                  <button
                    className="btn-utility"
                    onClick={() =>
                      onAction(() =>
                        api(`/api/users/${u.id}`, {
                          method: 'PATCH',
                          body: JSON.stringify({ disabled: !u.disabled }),
                        }),
                      )
                    }
                  >
                    {u.disabled ? '활성화' : '비활성화'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </>
  )
}

function TeamsTab({
  teams,
  users,
  onAction,
}: {
  teams: AdminTeam[]
  users: AdminUser[]
  onAction: (a: () => Promise<unknown>) => void
}) {
  const [name, setName] = useState('')

  return (
    <>
      <Card>
        <h3 style={{ fontSize: 21, marginBottom: 'var(--sp-sm)' }}>팀 만들기</h3>
        <form
          style={{ display: 'flex', gap: 'var(--sp-sm)' }}
          onSubmit={(e) => {
            e.preventDefault()
            onAction(() => api('/api/teams', { method: 'POST', body: JSON.stringify({ name }) }))
            setName('')
          }}
        >
          <input
            style={inputStyle}
            placeholder="팀 이름"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
          <button className="btn-primary" type="submit">
            생성
          </button>
        </form>
      </Card>

      {teams.map((team) => (
        <Card key={team.id}>
          <h3 style={{ fontSize: 21, marginBottom: 'var(--sp-sm)' }}>{team.name}</h3>
          <ul style={{ paddingLeft: 20 }}>
            {team.members.map((m) => (
              <li key={m.id} style={{ marginBottom: 4 }}>
                {m.email}{' '}
                <button
                  className="login-local-toggle"
                  onClick={() =>
                    onAction(() =>
                      api(`/api/teams/${team.id}/members/${m.id}`, { method: 'DELETE' }),
                    )
                  }
                >
                  제거
                </button>
              </li>
            ))}
            {team.members.length === 0 && (
              <li style={{ color: 'var(--ink-muted-48)' }}>팀원이 없습니다</li>
            )}
          </ul>
          <AddMember team={team} users={users} onAction={onAction} />
        </Card>
      ))}
    </>
  )
}

function AddMember({
  team,
  users,
  onAction,
}: {
  team: AdminTeam
  users: AdminUser[]
  onAction: (a: () => Promise<unknown>) => void
}) {
  const memberIds = new Set(team.members.map((m) => m.id))
  const candidates = users.filter((u) => !memberIds.has(u.id) && !u.disabled)
  const [userId, setUserId] = useState('')

  if (candidates.length === 0) return null
  return (
    <form
      style={{ display: 'flex', gap: 'var(--sp-sm)' }}
      onSubmit={(e) => {
        e.preventDefault()
        if (!userId) return
        onAction(() =>
          api(`/api/teams/${team.id}/members`, {
            method: 'POST',
            body: JSON.stringify({ user_id: userId }),
          }),
        )
        setUserId('')
      }}
    >
      <select value={userId} onChange={(e) => setUserId(e.target.value)} required>
        <option value="">팀원 추가…</option>
        {candidates.map((u) => (
          <option key={u.id} value={u.id}>
            {u.email}
          </option>
        ))}
      </select>
      <button className="btn-utility" type="submit">
        추가
      </button>
    </form>
  )
}

const inputStyle: React.CSSProperties = {
  font: 'inherit',
  border: '1px solid var(--hairline)',
  borderRadius: 'var(--radius-md)',
  padding: '10px 14px',
  background: 'var(--surface-pearl)',
  flex: '1 1 200px',
}

const thStyle: React.CSSProperties = { padding: '8px 6px', fontWeight: 600, fontSize: 13 }
const tdStyle: React.CSSProperties = { padding: '10px 6px' }
