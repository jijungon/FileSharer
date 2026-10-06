import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, ApiError } from '../lib/api'
import { copyText } from '../lib/clipboard'
import { formatAgo, formatDateTime } from '../lib/format'

interface TokenRow {
  id: string
  label: string
  scope_label: string
  created_at: string
  last_used_at: string | null
  expires_at: string | null
}

function Copyable({ text, id, copied, onCopy }: {
  text: string
  id: string
  copied: string
  onCopy: (text: string, id: string) => void
}) {
  return (
    <div className="cli-cmd">
      <code>{text}</code>
      <button className="btn-utility" onClick={() => onCopy(text, id)}>
        {copied === id ? '복사됨 ✓' : '복사'}
      </button>
    </div>
  )
}

/** CLI 안내 — 설치·로그인·명령, 그리고 **지금 로그인된 기기**.
 *
 * 문서만 두면 금방 낡는다. 토큰 목록과 회수를 같은 자리에 둬서, 읽으러 왔다가
 * 정리까지 하고 가게 한다. 주소가 있으니 동료에게 링크 하나 던지면 끝이다.
 */
export default function Cli() {
  const navigate = useNavigate()
  const [rows, setRows] = useState<TokenRow[] | null>(null)
  const [copied, setCopied] = useState('')
  const [err, setErr] = useState('')
  const origin = window.location.origin

  const reload = useCallback(() => {
    api<TokenRow[]>('/api/tokens')
      .then(setRows)
      .catch((e) => {
        if (e instanceof ApiError && e.status === 401) navigate('/login?next=/cli')
        else setErr(e instanceof Error ? e.message : '목록을 받지 못했습니다')
      })
  }, [navigate])

  useEffect(reload, [reload])

  async function copy(text: string, id: string) {
    if (await copyText(text)) {
      setCopied(id)
      setTimeout(() => setCopied(''), 1500)
    } else {
      setErr('복사하지 못했어요 — 길게 눌러 수동 복사해 주세요')
    }
  }

  async function revoke(row: TokenRow) {
    if (!confirm(`'${row.label || row.id}' 를 회수할까요? 그 기기는 바로 못 쓰게 됩니다.`)) return
    try {
      await api(`/api/tokens/${row.id}`, { method: 'DELETE' })
      reload()
    } catch (e) {
      setErr(e instanceof Error ? e.message : '회수하지 못했습니다')
    }
  }

  const steps: [string, string, string][] = [
    ['설치', `curl -fsSL ${origin}/cli/install.sh | sh`, 'install'],
    ['로그인', 'filesharer login', 'login'],
  ]

  return (
    <div className="cli-page">
      <h2>CLI — 브라우저 없이 쓰기</h2>
      <p className="muted cli-lede">
        사내 VM·CI 처럼 브라우저가 없는 곳에서 파일을 주고받을 때 씁니다. 파이썬 3만 있으면
        되고, 따로 설치할 패키지는 없습니다.
      </p>

      {steps.map(([title, cmd, id], i) => (
        <section key={id} className="cli-step">
          <h3>
            <span className="cli-step-no">{i + 1}</span> {title}
          </h3>
          <Copyable text={cmd} id={id} copied={copied} onCopy={copy} />
          {id === 'login' && (
            <p className="muted cli-note">
              터미널에 주소와 코드가 뜹니다. 그 주소를 브라우저에서 열고 코드를 넣으면
              끝입니다 — <strong>터미널과 브라우저가 다른 기계여도 됩니다.</strong> SSH 로
              들어간 서버에서 쓰는 걸 염두에 둔 방식입니다.
            </p>
          )}
        </section>
      ))}

      <section className="cli-step">
        <h3>
          <span className="cli-step-no">3</span> 쓰기
        </h3>
        <Copyable text="filesharer ls '내 공간'" id="ls" copied={copied} onCopy={copy} />
        <Copyable text="filesharer put 보고서.md '내 공간/IDP'" id="put" copied={copied} onCopy={copy} />
        <Copyable text="filesharer get '내 공간/IDP/보고서.md'" id="get" copied={copied} onCopy={copy} />
        <p className="muted cli-note">
          <code>filesharer whoami</code> 로 지금 어디까지 쓸 수 있는지, <code>filesharer logout</code>{' '}
          으로 이 기기의 자격을 지울 수 있습니다.
        </p>
      </section>

      <section className="cli-devices">
        <h3>지금 로그인된 기기</h3>
        {err && <p className="device-error">{err}</p>}
        {rows === null && <p className="muted">불러오는 중…</p>}
        {rows !== null && rows.length === 0 && (
          <p className="muted">아직 없습니다. 위 1·2번을 따라 하면 여기에 나타납니다.</p>
        )}
        {rows !== null && rows.length > 0 && (
          <table className="cli-table">
            <thead>
              <tr>
                <th>기기</th>
                <th>어디까지</th>
                <th>마지막 사용</th>
                <th>만료</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>{r.label || <span className="muted">(이름 없음)</span>}</td>
                  <td className="muted">{r.scope_label}</td>
                  {/* 안 쓰이는 자격이 남아 있으면 그게 정리 대상이다 — 그래서 '마지막 사용'을 보여준다 */}
                  <td className="muted">
                    {r.last_used_at ? formatAgo(r.last_used_at) : '쓰인 적 없음'}
                  </td>
                  <td className="muted">
                    {r.expires_at ? formatDateTime(r.expires_at).slice(0, 10) : '없음'}
                  </td>
                  <td>
                    <button className="btn-utility btn-danger-ghost" onClick={() => revoke(r)}>
                      회수
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  )
}
