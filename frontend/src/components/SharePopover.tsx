import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import { NodeInfo } from '../lib/files'

interface ShareInfo {
  id: string
  expires_at: string
  protected: boolean
  max_downloads: number | null
  download_count: number
}

interface CreatedShare extends ShareInfo {
  token: string
  url: string
  get_command: string
}

export default function SharePopover({ node, onClose }: { node: NodeInfo; onClose: () => void }) {
  const [days, setDays] = useState(7)
  const [password, setPassword] = useState('')
  const [maxDownloads, setMaxDownloads] = useState('')
  const [created, setCreated] = useState<CreatedShare | null>(null)
  const [existing, setExisting] = useState<ShareInfo[]>([])
  const [error, setError] = useState('')
  const [copied, setCopied] = useState('')

  const reload = () =>
    api<ShareInfo[]>(`/api/nodes/${node.id}/shares`).then(setExisting).catch(() => {})

  useEffect(() => {
    reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node.id])

  async function create() {
    setError('')
    try {
      const res = await api<CreatedShare>(`/api/nodes/${node.id}/shares`, {
        method: 'POST',
        body: JSON.stringify({
          days,
          password: password || null,
          max_downloads: maxDownloads ? Number(maxDownloads) : null,
        }),
      })
      setCreated(res)
      reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : '생성 실패')
    }
  }

  async function copy(text: string, label: string) {
    await navigator.clipboard.writeText(text)
    setCopied(label)
    setTimeout(() => setCopied(''), 1500)
  }

  const curlCommand = created
    ? node.type === 'folder'
      ? `mkdir -p '${node.name}' && curl -fL ${created.url}/tar | tar xzf - -C '${node.name}'`
      : `curl -fLOJ ${created.url}/download`
    : ''

  return (
    <div className="share-popover">
      <div className="share-head">
        <strong>공유 링크</strong> <span className="muted">{node.name}</span>
        <span className="toolbar-spacer" />
        <button className="row-action" style={{ visibility: 'visible' }} onClick={onClose}>
          닫기 ✕
        </button>
      </div>

      {created ? (
        <div className="share-result">
          <label className="share-label">원커맨드 — VM·터미널에서 한 줄로 받기+해제</label>
          <div className="share-copyrow">
            <code>{created.get_command}</code>
            <button className="btn-primary" onClick={() => copy(created.get_command, 'get')}>
              {copied === 'get' ? '복사됨 ✓' : '복사'}
            </button>
          </div>
          <label className="share-label">공유 URL (브라우저용, 만료 {days}일)</label>
          <div className="share-copyrow">
            <code>{created.url}</code>
            <button className="btn-utility" onClick={() => copy(created.url, 'url')}>
              {copied === 'url' ? '복사됨 ✓' : '복사'}
            </button>
          </div>
          <label className="share-label">수동 명령 (고급)</label>
          <div className="share-copyrow">
            <code>{curlCommand}</code>
            <button className="btn-utility" onClick={() => copy(curlCommand, 'curl')}>
              {copied === 'curl' ? '복사됨 ✓' : '복사'}
            </button>
          </div>
          <button className="login-local-toggle" onClick={() => setCreated(null)}>
            새 링크 더 만들기
          </button>
        </div>
      ) : (
        <div className="share-form">
          <label>
            만료
            <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
              <option value={1}>1일</option>
              <option value={7}>7일</option>
              <option value={30}>30일</option>
            </select>
          </label>
          <label>
            비밀번호 <span className="muted">(선택)</span>
            <input
              type="text"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="없음"
            />
          </label>
          <label>
            횟수 제한 <span className="muted">(선택)</span>
            <input
              type="number"
              min={1}
              value={maxDownloads}
              onChange={(e) => setMaxDownloads(e.target.value)}
              placeholder="무제한"
            />
          </label>
          <button className="btn-primary" onClick={create}>
            링크 만들기
          </button>
          {error && <div className="login-error">{error}</div>}
        </div>
      )}

      {existing.length > 0 && (
        <div className="share-existing">
          <label className="share-label">발급된 링크</label>
          {existing.map((s) => (
            <div key={s.id} className="share-row">
              <span className="muted">
                ~{s.expires_at.slice(0, 10)}
                {s.protected && ' · 🔒'}
                {s.max_downloads != null && ` · ${s.download_count}/${s.max_downloads}회`}
              </span>
              <button
                className="row-action"
                style={{ visibility: 'visible' }}
                onClick={() => api(`/api/shares/${s.id}`, { method: 'DELETE' }).then(reload)}
              >
                회수
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
