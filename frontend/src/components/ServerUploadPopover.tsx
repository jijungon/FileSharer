import { useState } from 'react'

interface Props {
  // 현재 디렉터리: 폴더 안이면 folderId, 공간 루트면 spaceId 로 대상이 정해진다.
  folderId: string | null
  spaceId: string | null
  label: string // 현재 위치 표시용(공간·폴더 이름)
  activeToken?: string | null // 방금 발급해 메모리에 든 토큰 — 있으면 curl에 자동 채움
  onOpenTokens?: () => void // 'API 토큰' 드로어 열기
  onClose: () => void
}

// 현재 폴더(또는 공간 루트)로 헤드리스 서버가 파일을 밀어 넣는 방법을 보여주는 팝오버.
// 방금 발급한 토큰(activeToken)이 있으면 curl에 그대로 채워 바로 복사해 쓸 수 있게 한다.
export default function ServerUploadPopover({
  folderId,
  spaceId,
  label,
  activeToken,
  onOpenTokens,
  onClose,
}: Props) {
  const [copied, setCopied] = useState('')

  const origin = window.location.origin
  const endpoint = folderId
    ? `${origin}/api/nodes/${folderId}/files`
    : `${origin}/api/spaces/${spaceId}/files`
  const tokenForCurl = activeToken || '<TOKEN>'
  const curl = `curl -H "Authorization: Bearer ${tokenForCurl}" -F file=@a.log ${endpoint}`
  // 표시용 마스킹: fsk_<id>. 까지만 보여주고 나머지 비밀은 가린다.
  const masked = activeToken
    ? `${activeToken.slice(0, activeToken.indexOf('.') + 1 || 12)}••••••`
    : ''

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
          방금 발급한 토큰(<code>{masked}</code>)이 아래 curl에 적용됐습니다. 바로 복사해 쓰세요.
          <br />
          <span style={{ fontSize: 12 }}>이 브라우저에서만 임시 적용 · 새로고침하면 해제됩니다.</span>
        </p>
      ) : (
        <p className="muted" style={{ margin: '2px 0' }}>
          브라우저 없이 이 위치로 파일을 올립니다. <code>&lt;TOKEN&gt;</code> 자리에 발급한 API
          토큰을 넣으세요.
        </p>
      )}

      <label className="share-label">업로드 엔드포인트 (POST · multipart)</label>
      <div className="share-copyrow">
        <code>{endpoint}</code>
        <button className="btn-utility" onClick={() => copy(endpoint, 'ep')}>
          {copied === 'ep' ? '복사됨 ✓' : '복사'}
        </button>
      </div>

      <label className="share-label">curl 한 줄</label>
      <div className="share-copyrow">
        <code>{curl}</code>
        <button className="btn-primary" onClick={() => copy(curl, 'curl')}>
          {copied === 'curl' ? '복사됨 ✓' : '복사'}
        </button>
      </div>

      <p className="muted" style={{ margin: '4px 0 0' }}>
        <button type="button" className="server-upload-link linklike" onClick={onOpenTokens}>
          API 토큰 발급/관리 →
        </button>{' '}
        · 여러 파일·폴더는 저장소의 <code>scripts/fs-upload.sh</code> 사용
      </p>
    </div>
  )
}
