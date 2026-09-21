import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api, ApiError, Me, SpaceInfo } from '../lib/api'
import {
  ApiTokenInfo,
  CreatedApiToken,
  createToken,
  listTokens,
  revokeToken,
} from '../lib/tokens'

// 서버(헤드리스) 업로드용 API 토큰 관리 — 로그인한 사용자가 '자기' 토큰을 발급/조회/회수한다.
export default function Tokens() {
  const navigate = useNavigate()
  const [tokens, setTokens] = useState<ApiTokenInfo[]>([])
  const [spaces, setSpaces] = useState<SpaceInfo[]>([])
  const [created, setCreated] = useState<CreatedApiToken | null>(null)
  const [error, setError] = useState('')

  const reload = useCallback(async () => {
    setTokens(await listTokens())
  }, [])

  useEffect(() => {
    api<Me>('/api/me')
      .then(() => Promise.all([reload(), api<SpaceInfo[]>('/api/spaces').then(setSpaces)]))
      .catch((err) => {
        if (err instanceof ApiError && err.status === 401) navigate('/login', { replace: true })
      })
  }, [navigate, reload])

  async function revoke(id: string) {
    if (!window.confirm('이 토큰을 회수할까요? 이 토큰을 쓰는 서버 업로드는 즉시 실패합니다.')) return
    setError('')
    try {
      await revokeToken(id)
      if (created?.id === id) setCreated(null)
      await reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : '회수에 실패했습니다')
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
        <h2>API 토큰</h2>
        <Link to="/files">← 파일로 돌아가기</Link>
      </header>

      <p className="muted" style={{ marginTop: 0 }}>
        서버(클라우드·IDC)에서 브라우저 없이 파일을 밀어 넣을 때 쓰는 토큰입니다.
        <code style={{ margin: '0 4px' }}>Authorization: Bearer &lt;토큰&gt;</code>
        헤더로 인증합니다. 토큰은 <strong>발급 직후 한 번만</strong> 표시되며, 서버에는 해시만
        저장됩니다.
      </p>

      {error && <p style={{ color: '#d70015', fontSize: 14 }}>{error}</p>}

      {created && (
        <CreatedTokenCard created={created} spaces={spaces} onDismiss={() => setCreated(null)} />
      )}

      <CreateTokenForm
        spaces={spaces}
        onCreated={(c) => {
          setCreated(c)
          reload()
        }}
        onError={setError}
      />

      <Card>
        <h3 style={{ fontSize: 21, marginBottom: 'var(--sp-sm)' }}>발급된 토큰</h3>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
          <thead>
            <tr style={{ textAlign: 'left', color: 'var(--ink-muted-48)' }}>
              <th style={thStyle}>라벨</th>
              <th style={thStyle}>범위</th>
              <th style={thStyle}>발급</th>
              <th style={thStyle}>마지막 사용</th>
              <th style={thStyle}>만료</th>
              <th style={thStyle}></th>
            </tr>
          </thead>
          <tbody>
            {tokens.map((t) => (
              <tr key={t.id} style={{ borderTop: '1px solid var(--divider-soft)' }}>
                <td style={tdStyle}>{t.label || <span className="muted">(무제)</span>}</td>
                <td style={tdStyle}>{t.scope_label}</td>
                <td style={tdStyle}>{fmtDate(t.created_at)}</td>
                <td style={tdStyle}>{t.last_used_at ? fmtDate(t.last_used_at) : '—'}</td>
                <td style={tdStyle}>{t.expires_at ? fmtDate(t.expires_at) : '없음'}</td>
                <td style={{ ...tdStyle, textAlign: 'right' }}>
                  <button className="btn-utility" onClick={() => revoke(t.id)}>
                    회수
                  </button>
                </td>
              </tr>
            ))}
            {tokens.length === 0 && (
              <tr>
                <td colSpan={6} className="muted" style={{ padding: '14px 6px' }}>
                  아직 발급된 토큰이 없습니다.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>
    </div>
  )
}

function CreateTokenForm({
  spaces,
  onCreated,
  onError,
}: {
  spaces: SpaceInfo[]
  onCreated: (c: CreatedApiToken) => void
  onError: (msg: string) => void
}) {
  const [label, setLabel] = useState('')
  const [scope, setScope] = useState('') // '' = 개인 공간(기본), 그 외 = space_id
  const [expires, setExpires] = useState('') // '' = 무기한

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    onError('')
    try {
      const created = await createToken({
        label: label.trim(),
        space_id: scope || null,
        expires_in_days: expires ? Number(expires) : null,
      })
      onCreated(created)
      setLabel('')
      setScope('')
      setExpires('')
    } catch (err) {
      onError(err instanceof Error ? err.message : '토큰 발급에 실패했습니다')
    }
  }

  return (
    <Card>
      <h3 style={{ fontSize: 21, marginBottom: 'var(--sp-sm)' }}>새 토큰 발급</h3>
      <form style={{ display: 'flex', gap: 'var(--sp-sm)', flexWrap: 'wrap' }} onSubmit={submit}>
        <input
          style={inputStyle}
          placeholder="라벨 (예: nightly-backup, ci-runner)"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          aria-label="토큰 라벨"
        />
        <select
          style={{ ...inputStyle, flex: '1 1 160px' }}
          value={scope}
          onChange={(e) => setScope(e.target.value)}
          aria-label="업로드 허용 공간"
        >
          <option value="">내 공간(기본)</option>
          {spaces
            .filter((s) => s.type !== 'personal')
            .map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
        </select>
        <select
          style={{ ...inputStyle, flex: '0 1 130px' }}
          value={expires}
          onChange={(e) => setExpires(e.target.value)}
          aria-label="만료"
        >
          <option value="">만료 없음</option>
          <option value="7">7일</option>
          <option value="30">30일</option>
          <option value="90">90일</option>
          <option value="365">365일</option>
        </select>
        <button className="btn-primary" type="submit">
          발급
        </button>
      </form>
      <p className="muted" style={{ marginBottom: 0 }}>
        범위를 좁힐수록 안전합니다. 특정 폴더로만 제한하려면 파일 화면의{' '}
        <strong>서버 업로드</strong> 버튼에서 그 폴더를 열고 발급하세요.
      </p>
    </Card>
  )
}

function CreatedTokenCard({
  created,
  spaces,
  onDismiss,
}: {
  created: CreatedApiToken
  spaces: SpaceInfo[]
  onDismiss: () => void
}) {
  const [copied, setCopied] = useState('')
  const copy = async (text: string, label: string) => {
    await navigator.clipboard.writeText(text)
    setCopied(label)
    setTimeout(() => setCopied(''), 1500)
  }

  const origin = window.location.origin
  const endpoint = created.node_id
    ? `${origin}/api/nodes/${created.node_id}/files`
    : `${origin}/api/spaces/${
        created.space_id ?? spaces.find((s) => s.type === 'personal')?.id ?? '<SPACE_ID>'
      }/files`
  const curl = `curl -H "Authorization: Bearer ${created.token}" -F file=@a.log ${endpoint}`

  return (
    <section
      style={{
        background: 'var(--canvas)',
        border: '2px solid var(--primary)',
        borderRadius: 'var(--radius-lg)',
        padding: 'var(--sp-lg)',
        marginBottom: 'var(--sp-lg)',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h3 style={{ fontSize: 19, margin: 0 }}>토큰이 발급되었습니다</h3>
        <button className="btn-utility" onClick={onDismiss}>
          닫기 ✕
        </button>
      </div>
      <p style={{ color: '#d70015', fontWeight: 600, fontSize: 14 }}>
        ⚠️ {created.warning}
      </p>
      <label className="share-label">토큰</label>
      <div className="share-copyrow">
        <code data-testid="token-value">{created.token}</code>
        <button className="btn-primary" onClick={() => copy(created.token, 'tok')}>
          {copied === 'tok' ? '복사됨 ✓' : '복사'}
        </button>
      </div>
      <label className="share-label">바로 쓰는 curl (이 토큰 · 이 범위)</label>
      <div className="share-copyrow">
        <code>{curl}</code>
        <button className="btn-utility" onClick={() => copy(curl, 'curl')}>
          {copied === 'curl' ? '복사됨 ✓' : '복사'}
        </button>
      </div>
    </section>
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

function fmtDate(iso: string | null): string {
  if (!iso) return '—'
  return iso.slice(0, 10)
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
