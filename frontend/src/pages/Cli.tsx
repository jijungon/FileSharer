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
          <strong>폴더도 됩니다.</strong> <code>put</code> 에 폴더를 주면 통째로 묶어 올리고
          서버가 풀어서 구조를 되살립니다. <code>get</code> 으로 폴더를 찍으면 그대로 받아
          풉니다 — 파일마다 명령을 치지 않아도 됩니다.
        </p>
        <p className="muted cli-note">
          <code>filesharer whoami</code> 로 지금 어느 계정으로 어디까지 쓸 수 있는지,{' '}
          <code>filesharer logout</code> 으로 이 기기의 자격을 지울 수 있습니다.
        </p>
      </section>

      <section className="cli-step">
        <h3>새 버전이 나오면</h3>
        <Copyable text="filesharer update" id="update" copied={copied} onCopy={copy} />
        <p className="muted cli-note">
          설치 명령을 다시 칠 필요 없이 <strong>자기 자신만 바꿉니다.</strong> 자격(로그인)은
          그대로라 다시 로그인하지 않아도 됩니다. 낡은 CLI 로 명령을 치면 하루에 한 번
          알려주는데, <strong>받아서 바꾸는 건 이 명령을 칠 때만</strong> 일어납니다.
        </p>
      </section>

      <section className="cli-step">
        <h3>명령 전체</h3>
        <dl className="cli-ref">
          <dt>filesharer login</dt>
          <dd>
            브라우저로 로그인. <code>--name</code> 으로 승인 화면에 뜰 기기 이름을,
            <code>--no-browser</code> 로 브라우저를 안 열게 할 수 있습니다.
          </dd>
          <dt>filesharer whoami</dt>
          <dd>지금 <strong>어느 계정</strong>으로, 어디까지, 언제까지 쓸 수 있는지</dd>
          <dt>filesharer ls [경로]</dt>
          <dd>경로를 빼면 쓸 수 있는 공간 목록이 나옵니다</dd>
          <dt>filesharer put &lt;파일·폴더…&gt; [경로]</dt>
          <dd>
            <strong>폴더도 됩니다</strong>(통째로 묶어 올리고 서버가 풉니다). 마지막 인자가
            내 컴퓨터에 없는 이름이면 올릴 곳으로 봅니다. 헷갈리면{' '}
            <code>--to &apos;내 공간/IDP&apos;</code> 로 못박으세요.
          </dd>
          <dt>filesharer get &lt;경로&gt;</dt>
          <dd>
            파일도 폴더도 받습니다. <code>-o</code> 로 저장 위치를, <code>--force</code> 로
            덮어쓰기를 지정합니다
          </dd>
          <dt>filesharer logout</dt>
          <dd>이 기기의 자격을 지웁니다(서버의 토큰은 아래에서 회수하세요)</dd>
          <dt>filesharer update</dt>
          <dd>서버의 최신 CLI 로 자기 자신을 바꿉니다. 자격은 그대로입니다</dd>
          <dt>filesharer --version</dt>
          <dd>지금 쓰고 있는 CLI 의 버전</dd>
        </dl>
        <p className="muted cli-note">
          모든 명령에 <code>--server</code> 를 붙여 다른 서버를 가리킬 수 있습니다. 평소엔
          필요 없습니다 — 설치할 때 받은 주소가 이미 들어 있습니다.
        </p>
      </section>

      <section className="cli-step">
        <h3>막힐 때</h3>
        <dl className="cli-ref">
          <dt>command not found: filesharer</dt>
          <dd>
            설치한 곳이 <code>PATH</code> 에 없습니다. 설치할 때 안내가 나오는데, 셸 설정에{' '}
            <code>export PATH=&quot;$HOME/.local/bin:$PATH&quot;</code> 를 더하거나{' '}
            <code>~/.local/bin/filesharer</code> 로 직접 부르세요.
          </dd>
          <dt>앞단(CDN·방화벽)에서 차단됐습니다</dt>
          <dd>
            회사 프록시나 CDN 이 중간에서 끊은 것입니다. <strong>서버 문제가 아닙니다</strong> —
            이 네트워크에서 그 주소로 나갈 수 있는지부터 보세요.
          </dd>
          <dt>로그인이 필요합니다</dt>
          <dd>
            아직 <code>login</code> 을 안 했거나, 자격이 만료·회수됐습니다. 아래 목록에서
            이 기기가 보이는지 확인하세요.
          </dd>
          <dt>python3 가 필요합니다</dt>
          <dd>
            CLI 는 파이썬 3 로 돌아갑니다. 대부분의 리눅스엔 이미 있습니다 —
            없으면 배포판 패키지로 설치하세요.
          </dd>
        </dl>
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
