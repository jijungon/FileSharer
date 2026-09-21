import { useState } from 'react'
import { createToken } from '../lib/tokens'

interface Props {
  // 현재 디렉터리: 폴더 안이면 folderId, 공간 루트면 spaceId 로 대상이 정해진다.
  folderId: string | null
  spaceId: string | null
  label: string // 현재 위치 표시용(공간·폴더 이름)
  activeToken?: string | null // 지금 메모리에 든 임시 토큰 — 있으면 curl에 자동 채움
  onActiveToken: (token: string | null) => void // 발급 시 원문 올림 / null=해제
  onClose: () => void
}

// 이 위치로 유효한 '임시 토큰'을 서버에서 몇 분간만 살아있게 발급하고, 그 창 안에서
// 헤드리스 서버가 파일(여러 개 가능)을 밀어 넣게 하는 팝오버. 관리 페이지 없이 버튼 하나로 끝난다.
const EXPIRES_MIN = 10 // 임시 토큰 유효(분). 짧게 — 그 안에 여러 파일 OK, 지나면 자동 만료.

export default function ServerUploadPopover({
  folderId,
  spaceId,
  label,
  activeToken,
  onActiveToken,
  onClose,
}: Props) {
  const [copied, setCopied] = useState('')
  const [minting, setMinting] = useState(false)
  const [error, setError] = useState('')

  const origin = window.location.origin
  // 목적지는 '토큰'에 담겨 있다(발급한 위치 = 업로드 위치) → URL엔 폴더/공간 id가 없다.
  const endpoint = `${origin}/api/upload`
  const tokenForCurl = activeToken || '<TOKEN>'
  // 파일 여러 개는 -F file=@ 를 여러 번 붙이면 한 요청에 모두 올라간다.
  const curl = `curl -H "Authorization: Bearer ${tokenForCurl}" -F file=@a.log -F file=@b.log ${endpoint}`
  // 폴더째: tar로 묶어 보내면 서버가 ?extract=tar 로 풀어 하위 구조까지 재현한다.
  const tarCurl = `tar czf - mydir | curl -H "Authorization: Bearer ${tokenForCurl}" -F file=@- "${endpoint}?extract=tar"`
  // 표시용 마스킹: fsk_<id>. 까지만 보여주고 나머지 비밀은 가린다.
  const masked = activeToken
    ? `${activeToken.slice(0, activeToken.indexOf('.') + 1 || 12)}••••••`
    : ''

  async function mint() {
    if (!spaceId) return
    setError('')
    setMinting(true)
    try {
      // 폴더 안이면 그 폴더로만, 공간 루트면 그 공간으로만 범위를 좁혀 발급(짧은 만료).
      const created = await createToken({
        label: `임시 업로드 · ${label}`,
        node_id: folderId,
        space_id: folderId ? null : spaceId,
        expires_in_minutes: EXPIRES_MIN,
      })
      onActiveToken(created.token) // 메모리에만 — 서버 업로드 curl 자동 채움
    } catch (err) {
      setError(err instanceof Error ? err.message : '토큰 발급에 실패했습니다')
    } finally {
      setMinting(false)
    }
  }

  async function copy(text: string, key: string) {
    await navigator.clipboard.writeText(text)
    setCopied(key)
    setTimeout(() => setCopied(''), 1500)
  }

  return (
    <div className="share-popover" role="dialog" aria-label="서버 업로드">
      <div className="share-head">
        <strong>서버 업로드</strong> <span className="muted">{label}</span>
        <span className="toolbar-spacer" style={{ flex: 1 }} />
        <button className="row-action" style={{ visibility: 'visible' }} onClick={onClose}>
          닫기 ✕
        </button>
      </div>

      {activeToken ? (
        <p className="muted" style={{ margin: '2px 0' }}>
          임시 토큰(<code>{masked}</code>)이 적용됐습니다 — 이 토큰은 <strong>{label}</strong>로
          업로드됩니다(목적지가 토큰에 담김).{' '}
          <button type="button" className="linklike" onClick={() => onActiveToken(null)}>
            해제
          </button>
          <br />
          <span style={{ fontSize: 12 }}>
            {EXPIRES_MIN}분간 유효 · 한 토큰으로 여러 파일 OK · 지나면 자동 만료(브라우저 메모리에만
            보관).
          </span>
        </p>
      ) : (
        <>
          <p className="muted" style={{ margin: '2px 0 6px' }}>
            브라우저 없이 <strong>{label}</strong>로 파일을 올립니다. 아래 버튼으로{' '}
            <strong>{EXPIRES_MIN}분짜리 임시 토큰</strong>을 발급하면 curl에 자동으로 채워집니다.
            목적지는 토큰에 담겨 URL에 폴더 지정이 필요 없습니다.
          </p>
          <button className="btn-primary" onClick={mint} disabled={minting || !spaceId}>
            {minting ? '발급 중…' : '🔑 임시 토큰 발급'}
          </button>
          {error && (
            <p style={{ color: '#d70015', fontSize: 13, margin: '6px 0 0' }}>{error}</p>
          )}
        </>
      )}

      <label className="share-label">업로드 엔드포인트 (POST · multipart)</label>
      <div className="share-copyrow">
        <code>{endpoint}</code>
        <button className="btn-utility" onClick={() => copy(endpoint, 'ep')}>
          {copied === 'ep' ? '복사됨 ✓' : '복사'}
        </button>
      </div>

      <label className="share-label">curl 한 줄 (파일 · 여러 개 가능)</label>
      <div className="share-copyrow">
        <code data-testid="server-upload-curl">{curl}</code>
        <button className="btn-primary" onClick={() => copy(curl, 'curl')}>
          {copied === 'curl' ? '복사됨 ✓' : '복사'}
        </button>
      </div>

      <label className="share-label">폴더째 (tar로 묶어 보내면 서버가 해제 · 구조 유지)</label>
      <div className="share-copyrow">
        <code data-testid="server-upload-tar">{tarCurl}</code>
        <button className="btn-utility" onClick={() => copy(tarCurl, 'tar')}>
          {copied === 'tar' ? '복사됨 ✓' : '복사'}
        </button>
      </div>

      <p className="muted" style={{ margin: '4px 0 0' }}>
        단일 파일은 <code>-F file=@a.log</code> 하나 · <code>mydir</code>는 올릴 폴더 경로로 바꾸세요 ·
        토큰은 발급 직후 한 번만 표시되고 서버엔 해시만 저장됩니다.
      </p>
    </div>
  )
}
