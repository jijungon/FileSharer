import { useCallback, useEffect, useState } from 'react'
import { api, SpaceInfo } from '../lib/api'
import { ApiTokenInfo, CreatedApiToken, createToken, listTokens, revokeToken } from '../lib/tokens'

// 이번 세션(브라우저 메모리)에 발급해 '원문을 아는' 토큰 — 서버 업로드 자동 채움에 쓸 수 있다.
// 새로고침하면 사라진다(디스크/스토리지에 저장하지 않음).
export interface SessionToken {
  id: string
  label: string
  token: string
}

interface Props {
  open: boolean
  onClose: () => void
  spaceId: string | null // 현재 활성 공간 — 발급 폼 기본값 + 목록 필터
  sessionTokens: SessionToken[] // 이번 세션에 발급한 토큰(원문 메모리 보관)
  activeToken: string | null // 서버 업로드에 적용 중인 토큰 원문
  onTokenCreated: (created: CreatedApiToken) => void // 발급 시: 세션 목록 추가 + 활성화
  onUseToken: (token: string) => void // 목록에서 '사용' → 활성 토큰 지정
}

// 서버(헤드리스) 업로드용 API 토큰 관리 — 우측 슬라이드 드로어(현재 공간 기준).
export default function TokenDrawer({
  open,
  onClose,
  spaceId,
  sessionTokens,
  activeToken,
  onTokenCreated,
  onUseToken,
}: Props) {
  const [tokens, setTokens] = useState<ApiTokenInfo[]>([])
  const [spaces, setSpaces] = useState<SpaceInfo[]>([])
  const [created, setCreated] = useState<CreatedApiToken | null>(null)
  const [error, setError] = useState('')

  const reload = useCallback(async () => {
    setTokens(await listTokens())
  }, [])

  useEffect(() => {
    if (!open) return
    setError('')
    Promise.all([reload(), api<SpaceInfo[]>('/api/spaces').then(setSpaces)]).catch((err) =>
      setError(err instanceof Error ? err.message : '불러오지 못했습니다'),
    )
  }, [open, reload])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  async function revoke(id: string) {
    if (!window.confirm('이 토큰을 회수할까요? 이 토큰을 쓰는 서버 업로드는 즉시 실패합니다.')) return
    setError('')
    try {
      await revokeToken(id)
      await reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : '회수에 실패했습니다')
    }
  }

  const currentSpace = spaces.find((s) => s.id === spaceId) ?? null
  const currentSpaceName = currentSpace?.name ?? '내 공간'
  // 목록만 현재(사이드바) 공간에 해당하는 토큰으로 필터. 발급 폼 드롭다운은 main과 동기화하지 않는다.
  const shownTokens = tokens.filter((t) => t.space === spaceId)

  return (
    <aside
      className={`token-drawer${open ? ' open' : ''}`}
      role="dialog"
      aria-label="API 토큰"
      aria-hidden={!open}
    >
      <div className="token-drawer-head">
        <h2>API 토큰</h2>
        <button className="btn-utility" onClick={onClose} aria-label="닫기">
          닫기 ✕
        </button>
      </div>

      <div className="token-drawer-body">
        <p className="muted" style={{ marginTop: 0 }}>
          현재 공간: <strong>{currentSpaceName}</strong> · 서버(클라우드·IDC)에서 브라우저 없이 파일을
          밀어 넣을 때 쓰는 토큰입니다. <code>Authorization: Bearer &lt;토큰&gt;</code> 헤더로
          인증하며, 토큰은 <strong>발급 직후 한 번만</strong> 표시됩니다(비밀번호처럼).
        </p>

        {error && <p style={{ color: '#d70015', fontSize: 14 }}>{error}</p>}

        {created && (
          <CreatedTokenCard created={created} spaces={spaces} onDismiss={() => setCreated(null)} />
        )}

        <CreateTokenForm
          spaces={spaces}
          onCreated={(c) => {
            setCreated(c)
            onTokenCreated(c) // 세션 목록 추가 + 서버 업로드에 자동 적용
            reload()
          }}
          onError={setError}
        />

        <h3 className="token-section-title">발급된 토큰 · {currentSpaceName}</h3>
        <table className="token-table">
          <thead>
            <tr>
              <th>라벨</th>
              <th>범위</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {shownTokens.map((t) => {
              const sess = sessionTokens.find((s) => s.id === t.id)
              const isActive = sess != null && sess.token === activeToken
              return (
                <tr key={t.id}>
                  <td>{t.label || <span className="muted">(무제)</span>}</td>
                  <td>{t.scope_label}</td>
                  <td className="token-actions">
                    {sess ? (
                      <button
                        className={`btn-utility${isActive ? ' active' : ''}`}
                        onClick={() => onUseToken(sess.token)}
                        title="이 토큰을 서버 업로드에 사용"
                      >
                        {isActive ? '적용 중 ✓' : '사용'}
                      </button>
                    ) : (
                      <span className="muted" title="발급 시 한 번만 표시됩니다 — 자동 채움하려면 재발급하세요">
                        재발급 필요
                      </span>
                    )}
                    <button className="btn-utility" onClick={() => revoke(t.id)}>
                      회수
                    </button>
                  </td>
                </tr>
              )
            })}
            {shownTokens.length === 0 && (
              <tr>
                <td colSpan={3} className="muted" style={{ padding: '14px 6px' }}>
                  이 공간에 발급된 토큰이 없습니다.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </aside>
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
  const [scope, setScope] = useState('') // '' = 개인 공간(기본), 그 외 = space_id (수동 선택)
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
      setExpires('')
    } catch (err) {
      onError(err instanceof Error ? err.message : '토큰 발급에 실패했습니다')
    }
  }

  return (
    <section className="token-card">
      <h3 className="token-section-title">새 토큰 발급</h3>
      <form className="token-form" onSubmit={submit}>
        <input
          className="token-input"
          placeholder="라벨 (예: nightly-backup, ci-runner)"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          aria-label="토큰 라벨"
        />
        <select
          className="token-input"
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
          className="token-input"
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
        범위를 좁힐수록 안전합니다. 특정 폴더로만 제한하려면 파일 화면의 <strong>서버 업로드</strong>{' '}
        버튼에서 그 폴더를 열고 발급하세요.
      </p>
    </section>
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
    <section className="token-card token-card--new">
      <div className="token-card-head">
        <h3 style={{ fontSize: 18, margin: 0 }}>토큰이 발급되었습니다</h3>
        <button className="btn-utility" onClick={onDismiss}>
          닫기 ✕
        </button>
      </div>
      <p style={{ color: '#d70015', fontWeight: 600, fontSize: 14 }}>⚠️ {created.warning}</p>
      <p className="token-active-note">
        ✓ 이 토큰이 <strong>서버 업로드</strong>에 자동 적용됩니다(이 브라우저에서만, 새로고침하면
        해제).
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
