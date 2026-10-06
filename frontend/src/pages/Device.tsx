import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { api, ApiError, Me, SpaceInfo } from '../lib/api'
import { formatAgo } from '../lib/format'
import { ro } from '../lib/josa'

interface Pending {
  user_code: string
  client_name: string
  client_ip: string
  created_at: string
  expires_at: string
  default_days: number
}

/** CLI 로그인 승인 화면 (디바이스 플로우).
 *
 * 터미널이 띄운 코드를 사람이 여기 옮겨 적고, **무엇을 허락하는지 보고** 허용을 누른다.
 * 이 방식의 알려진 약점이 "이 코드 좀 넣어주세요" 피싱이라, 기기 이름·요청 IP·요청
 * 시각을 작게 숨기지 않고 크게 보여준다. 사람이 '내가 방금 친 그 명령이 맞나' 를
 * 가늠할 단서가 화면에 있어야 한다.
 */
export default function Device() {
  const [params, setParams] = useSearchParams()
  const navigate = useNavigate()
  const [code, setCode] = useState(params.get('code') ?? '')
  const [pending, setPending] = useState<Pending | null>(null)
  const [spaces, setSpaces] = useState<SpaceInfo[]>([])
  const [me, setMe] = useState<Me | null>(null)
  const [spaceId, setSpaceId] = useState('') // '' = 내 공간만(기본값)
  const [days, setDays] = useState(90)
  const [err, setErr] = useState('')
  const [done, setDone] = useState<'approved' | 'denied' | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    // 내가 누구인지도 같이 받는다 — 아래에서 '누구 자격을 내주는지' 를 보여줘야 한다
    api<Me>('/api/me').then(setMe).catch(() => setMe(null))
    api<SpaceInfo[]>('/api/spaces')
      .then(setSpaces)
      .catch((e) => {
        if (e instanceof ApiError && e.status === 401) {
          // 로그인하고 돌아오면 코드가 그대로 남아 있게 주소에 실어 보낸다
          navigate(`/login?next=${encodeURIComponent(location.pathname + location.search)}`)
        }
      })
  }, [navigate])

  const look = useCallback(async (raw: string) => {
    setErr('')
    setPending(null)
    const c = raw.trim()
    if (!c) return
    try {
      setPending(await api<Pending>(`/api/device/pending?code=${encodeURIComponent(c)}`))
    } catch (e) {
      setErr(e instanceof Error ? e.message : '코드를 확인하지 못했습니다')
    }
  }, [])

  // 주소에 코드가 실려 오면(터미널이 verification_uri_complete 를 띄웠을 때) 바로 조회
  useEffect(() => {
    const fromUrl = params.get('code')
    if (fromUrl) void look(fromUrl)
  }, [params, look])

  async function act(kind: 'approve' | 'deny') {
    if (!pending) return
    setBusy(true)
    setErr('')
    try {
      const body =
        kind === 'approve'
          ? { code: pending.user_code, space_id: spaceId || null, days }
          : { code: pending.user_code }
      await api(`/api/device/${kind}`, { method: 'POST', body: JSON.stringify(body) })
      setDone(kind === 'approve' ? 'approved' : 'denied')
    } catch (e) {
      setErr(e instanceof Error ? e.message : '처리하지 못했습니다')
    } finally {
      setBusy(false)
    }
  }

  const target = spaces.find((s) => s.id === spaceId)?.name ?? '내 공간'

  if (done) {
    return (
      <div className="device-page">
        <Link className="page-back" to="/files">
          ← 파일로 돌아가기
        </Link>
        <h2>{done === 'approved' ? '허용했습니다' : '거부했습니다'}</h2>
        <p className="muted">
          {done === 'approved'
            ? '터미널로 돌아가세요 — 몇 초 안에 로그인이 끝납니다. 이 창은 닫아도 됩니다.'
            : '터미널의 요청을 막았습니다. 내가 시작한 게 아니라면 그대로 두세요.'}
        </p>
      </div>
    )
  }

  return (
    <div className="device-page">
      <Link className="page-back" to="/files">
        ← 파일로 돌아가기
      </Link>
      <h2>CLI 로그인 승인</h2>
      <p className="muted device-lede">
        터미널에 뜬 코드를 그대로 옮겨 적으세요. 허용하면 그 터미널이 당신 자격으로 파일을
        읽고 쓸 수 있게 됩니다.
      </p>

      <form
        className="device-codebox"
        onSubmit={(e) => {
          e.preventDefault()
          setParams(code ? { code } : {})
          void look(code)
        }}
      >
        <input
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="XXXX-XXXX"
          aria-label="터미널에 뜬 코드"
          autoFocus
          spellCheck={false}
        />
        <button className="btn-utility" type="submit">
          확인
        </button>
      </form>

      {err && <p className="device-error">{err}</p>}

      {pending && (
        <div className="device-request">
          {/* 피싱 방어의 핵심 — 무엇을 허락하는지가 눈에 보여야 한다 */}
          <dl className="device-facts">
            {/* **맨 위에 계정.** 토큰은 지금 이 브라우저 세션의 계정을 물려받는다.
                공용 브라우저에 남의 계정으로 로그인돼 있으면, 그 자격을 모른 채
                터미널에 내주게 된다. 기기·IP 보다 먼저 확인할 것이다. */}
            <dt>누구 자격으로</dt>
            <dd>{me ? me.email : '(확인 중…)'}</dd>
            <dt>기기</dt>
            <dd>{pending.client_name || '(이름 없음)'}</dd>
            <dt>요청 IP</dt>
            <dd>{pending.client_ip || '(알 수 없음)'}</dd>
            <dt>요청 시각</dt>
            <dd>{formatAgo(pending.created_at)}</dd>
          </dl>

          <p className="device-warn">
            내가 방금 터미널에서 <code>login</code> 을 친 게 아니라면 <strong>거부</strong>하세요.
            남이 보내온 코드를 대신 넣어주는 일은 하지 마세요. 위의 계정이 내 계정이 맞는지도
            확인하세요 — 공용 브라우저라면 남의 계정으로 로그인돼 있을 수 있습니다.
          </p>

          <label className="device-field">
            <span>어디까지</span>
            <select value={spaceId} onChange={(e) => setSpaceId(e.target.value)}>
              <option value="">내 공간만 (기본)</option>
              {spaces.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>

          <label className="device-field">
            <span>얼마 동안</span>
            <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
              <option value={7}>7일</option>
              <option value={30}>30일</option>
              <option value={90}>90일 (기본)</option>
              <option value={365}>1년</option>
            </select>
          </label>

          <p className="muted device-summary">
            <strong>{pending.client_name || '이 기기'}</strong>가{' '}
            {me && (
              <>
                <strong>{me.email}</strong> 자격으로{' '}
              </>
            )}
            <strong>{target}</strong>
            {ro(target)} {days}일 동안 접근합니다. 언제든 회수할 수 있습니다.
          </p>

          <div className="device-actions">
            <button
              className="btn-utility btn-tier-link"
              disabled={busy}
              onClick={() => void act('approve')}
            >
              허용
            </button>
            <button className="btn-utility" disabled={busy} onClick={() => void act('deny')}>
              거부
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
