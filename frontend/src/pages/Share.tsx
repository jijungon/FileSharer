import { useCallback, useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import MarkdownPreview from '../components/MarkdownPreview'
import { formatBytes } from '../lib/format'

interface ShareMeta {
  name: string
  type: 'file' | 'folder'
  size: number
  mime: string
  protected: boolean
  expires_at: string
}

function extOf(name: string) {
  const i = name.lastIndexOf('.')
  return i === -1 ? '' : name.slice(i + 1).toLowerCase()
}

export default function Share() {
  const { token } = useParams()
  const [meta, setMeta] = useState<ShareMeta | null>(null)
  const [gone, setGone] = useState('')
  const [password, setPassword] = useState('')
  const [unlocked, setUnlocked] = useState(false)
  const [pwError, setPwError] = useState('')
  const [text, setText] = useState<string | null>(null)
  const [blobUrl, setBlobUrl] = useState('')
  const [showAdvanced, setShowAdvanced] = useState(false)

  const base = `/s/${token}`

  useEffect(() => {
    fetch(`${base}/meta`).then(async (res) => {
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        setGone(body?.detail ?? '링크를 열 수 없습니다')
        return
      }
      const m = (await res.json()) as ShareMeta
      setMeta(m)
      if (!m.protected) setUnlocked(true)
    })
  }, [base])

  const loadPreview = useCallback(
    async (m: ShareMeta) => {
      if (m.type !== 'file') return
      const headers: Record<string, string> = password ? { 'X-Share-Password': password } : {}
      const isMd = ['md', 'markdown', 'txt'].includes(extOf(m.name))
      const isImg = m.mime.startsWith('image/')
      const isPdf = m.mime === 'application/pdf' || extOf(m.name) === 'pdf'
      if (!isMd && !isImg && !isPdf) return
      const res = await fetch(`${base}/raw`, { headers })
      if (!res.ok) throw new Error('unauthorized')
      if (isMd) setText(await res.text())
      else setBlobUrl(URL.createObjectURL(await res.blob()))
    },
    [base, password],
  )

  useEffect(() => {
    if (meta && unlocked) loadPreview(meta).catch(() => setUnlocked(false))
  }, [meta, unlocked, loadPreview])

  async function unlock() {
    setPwError('')
    const res = await fetch(`${base}/raw`, { headers: { 'X-Share-Password': password } })
    if (res.status === 401) {
      setPwError('비밀번호가 올바르지 않습니다')
      return
    }
    setUnlocked(true)
  }

  if (gone)
    return (
      <div className="login-page">
        <div className="login-card">
          <h1>🔗</h1>
          <p>{gone}</p>
        </div>
      </div>
    )

  if (!meta) return null

  if (meta.protected && !unlocked)
    return (
      <div className="login-page">
        <div className="login-card">
          <h1>🔒</h1>
          <p className="tagline">비밀번호가 걸린 공유입니다</p>
          <div className="login-local">
            <input
              type="password"
              placeholder="비밀번호"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && unlock()}
            />
            <button className="btn-primary" onClick={unlock}>
              열기
            </button>
            <div className="login-error">{pwError}</div>
          </div>
        </div>
      </div>
    )

  const isMd = ['md', 'markdown', 'txt'].includes(extOf(meta.name))
  const isImg = meta.mime.startsWith('image/')
  const isPdf = meta.mime === 'application/pdf' || extOf(meta.name) === 'pdf'
  const downloadHref = `${base}/download`
  const oneCommand = `curl -fsSL ${window.location.origin}${base}/get | sh`
  const curl =
    meta.type === 'folder'
      ? `mkdir -p '${meta.name}' && curl -fL ${window.location.origin}${base}/tar | tar xzf - -C '${meta.name}'`
      : `curl -fLOJ ${window.location.origin}${base}/download`

  return (
    <div className="share-page">
      <header className="share-page-head">
        <div>
          <h2>{meta.type === 'folder' ? '📁' : '📄'} {meta.name}</h2>
          <span className="muted">
            {meta.type === 'file' ? formatBytes(meta.size) : '폴더 (tar.gz로 받아집니다)'} · 만료{' '}
            {meta.expires_at.slice(0, 10)}
          </span>
        </div>
        <a href={downloadHref}>
          <button className="btn-primary">다운로드</button>
        </a>
      </header>

      <main className="share-page-body">
        {isMd && text !== null && <MarkdownPreview text={text} />}
        {isImg && blobUrl && (
          <div className="image-preview">
            <img src={blobUrl} alt={meta.name} />
          </div>
        )}
        {isPdf && blobUrl && <iframe className="pdf-frame share-pdf" src={blobUrl} title={meta.name} />}
        {meta.type === 'file' && !isMd && !isImg && !isPdf && (
          <p className="muted">미리보기를 지원하지 않는 형식입니다 — 위의 다운로드를 이용하세요.</p>
        )}
        {meta.type === 'folder' && (
          <p className="muted">폴더 공유입니다. 다운로드 버튼을 누르면 tar.gz로 받아집니다.</p>
        )}

        <button className="login-local-toggle" onClick={() => setShowAdvanced((v) => !v)}>
          {showAdvanced ? '고급 명령 접기' : '고급: 터미널(VM)에서 받기'}
        </button>
        {showAdvanced && (
          <pre className="share-curl">
            {`# 원커맨드 (다운로드+해제+검증)\n${oneCommand}\n\n# 수동\n${curl}`}
            {meta.protected ? "\n\n# 비밀번호 링크: SHARE_PW='<비밀번호>' 를 앞에 붙이거나 curl -u :'<비밀번호>'" : ''}
          </pre>
        )}
      </main>
    </div>
  )
}
