import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api, ApiError, Me, SpaceInfo } from '../lib/api'
import { NodeInfo, restoreNode } from '../lib/files'
import { formatBytes } from '../lib/format'

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
  const [tab, setTab] = useState<'users' | 'teams' | 'system'>('users')
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
        <button
          className={tab === 'system' ? 'btn-primary' : 'btn-ghost'}
          onClick={() => setTab('system')}
        >
          시스템
        </button>
      </nav>

      {error && <p style={{ color: '#d70015', fontSize: 14 }}>{error}</p>}

      {tab === 'users' && <UsersTab users={users} onAction={run} />}
      {tab === 'teams' && <TeamsTab teams={teams} users={users} onAction={run} />}
      {tab === 'system' && <SystemTab onError={setError} />}
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


interface DiskInfo {
  total: number
  used: number
  free: number
  used_ratio: number
  blob_bytes: number
  warn: boolean
  warn_ratio: number
}

interface AuditRow {
  id: number
  at: string | null
  action: string
  user: string
  detail: string
}

function SystemTab({ onError }: { onError: (msg: string) => void }) {
  const [disk, setDisk] = useState<DiskInfo | null>(null)
  const [auditRows, setAuditRows] = useState<AuditRow[]>([])
  const [actionFilter, setActionFilter] = useState('')
  const [spaces, setSpaces] = useState<SpaceInfo[]>([])
  const [trashSpace, setTrashSpace] = useState('')
  const [trash, setTrash] = useState<NodeInfo[]>([])

  useEffect(() => {
    api<DiskInfo>('/api/system/disk').then(setDisk).catch(() => {})
    api<SpaceInfo[]>('/api/spaces').then(setSpaces).catch(() => {})
  }, [])

  useEffect(() => {
    const q = actionFilter ? `?action=${actionFilter}` : ''
    api<AuditRow[]>(`/api/system/audit${q}`).then(setAuditRows).catch(() => {})
  }, [actionFilter])

  const loadTrash = (spaceId: string) => {
    setTrashSpace(spaceId)
    if (spaceId) api<NodeInfo[]>(`/api/spaces/${spaceId}/trash`).then(setTrash).catch(() => {})
    else setTrash([])
  }

  async function act(fn: () => Promise<unknown>) {
    try {
      await fn()
      if (trashSpace) loadTrash(trashSpace)
    } catch (err) {
      onError(err instanceof Error ? err.message : '요청 실패')
    }
  }

  return (
    <>
      <Card>
        <h3 style={{ fontSize: 21, marginBottom: 'var(--sp-sm)' }}>디스크</h3>
        {disk && (
          <div className="disk-card">
            <div className="disk-bar">
              <div
                className={`disk-fill${disk.warn ? ' warn' : ''}`}
                style={{ width: `${Math.round(disk.used_ratio * 100)}%` }}
              />
            </div>
            <span className="muted">
              사용 {formatBytes(disk.used)} / 전체 {formatBytes(disk.total)} (
              {Math.round(disk.used_ratio * 100)}%) · 파일 본체 {formatBytes(disk.blob_bytes)}
              {disk.warn && <strong style={{ color: '#d70015' }}> · 임계치 초과!</strong>}
            </span>
          </div>
        )}
      </Card>

      <Card>
        <h3 style={{ fontSize: 21, marginBottom: 'var(--sp-sm)' }}>
          휴지통 관리 <span className="muted" style={{ fontWeight: 400 }}>(복원 / 영구 삭제)</span>
        </h3>
        <select value={trashSpace} onChange={(e) => loadTrash(e.target.value)}>
          <option value="">공간 선택…</option>
          {spaces.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <ul style={{ paddingLeft: 20 }}>
          {trash.map((n) => (
            <li key={n.id} style={{ marginBottom: 4 }}>
              {n.type === 'folder' ? '📁' : '📄'} {n.name}{' '}
              <button
                className="login-local-toggle"
                onClick={() => act(() => restoreNode(n.id))}
              >
                복원
              </button>{' '}
              <button
                className="login-local-toggle"
                style={{ color: '#d70015' }}
                onClick={() => {
                  if (window.confirm(`"${n.name}" 영구 삭제? 되돌릴 수 없습니다.`))
                    act(() => api(`/api/system/nodes/${n.id}/purge`, { method: 'DELETE' }))
                }}
              >
                영구 삭제
              </button>
            </li>
          ))}
          {trashSpace && trash.length === 0 && (
            <li className="muted">이 공간의 휴지통은 비어 있습니다</li>
          )}
        </ul>
      </Card>

      <Card>
        <h3 style={{ fontSize: 21, marginBottom: 'var(--sp-sm)' }}>감사 로그</h3>
        <select value={actionFilter} onChange={(e) => setActionFilter(e.target.value)}>
          <option value="">전체 액션</option>
          {['upload', 'download', 'share_create', 'share_download', 'edit', 'delete', 'restore', 'purge', 'move', 'rename'].map(
            (a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ),
          )}
        </select>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, marginTop: 8 }}>
          <thead>
            <tr style={{ textAlign: 'left', color: 'var(--ink-muted-48)' }}>
              <th style={thStyle}>시각</th>
              <th style={thStyle}>사용자</th>
              <th style={thStyle}>액션</th>
              <th style={thStyle}>내용</th>
            </tr>
          </thead>
          <tbody>
            {auditRows.map((r) => (
              <tr key={r.id} style={{ borderTop: '1px solid var(--divider-soft)' }}>
                <td style={tdStyle}>{r.at?.slice(0, 19).replace('T', ' ')}</td>
                <td style={tdStyle}>{r.user}</td>
                <td style={tdStyle}>{r.action}</td>
                <td style={tdStyle}>{r.detail}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </>
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
