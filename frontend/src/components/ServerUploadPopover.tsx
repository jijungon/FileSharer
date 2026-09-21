import { useState } from 'react'
import { Link } from 'react-router-dom'

interface Props {
  // 현재 디렉터리: 폴더 안이면 folderId, 공간 루트면 spaceId 로 대상이 정해진다.
  folderId: string | null
  spaceId: string | null
  label: string // 현재 위치 표시용(공간·폴더 이름)
  onClose: () => void
}

// 현재 폴더(또는 공간 루트)로 헤드리스 서버가 파일을 밀어 넣는 방법을 보여주는 팝오버.
// LinkBar 액션 묶음(다운로드·사내 링크·공유 링크)의 '서버 업로드' 버튼에서 연다.
// 토큰 원문은 여기서 만들지 않고 <TOKEN> 자리표시자만 쓴다.
export default function ServerUploadPopover({ folderId, spaceId, label, onClose }: Props) {
  const [copied, setCopied] = useState('')

  const origin = window.location.origin
  const endpoint = folderId
    ? `${origin}/api/nodes/${folderId}/files`
    : `${origin}/api/spaces/${spaceId}/files`
  const curl = `curl -H "Authorization: Bearer <TOKEN>" -F file=@a.log ${endpoint}`

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

      <p className="muted" style={{ margin: '2px 0' }}>
        브라우저 없이 이 위치로 파일을 올립니다. <code>&lt;TOKEN&gt;</code> 자리에 발급한 API
        토큰을 넣으세요.
      </p>

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
        토큰이 없으면{' '}
        <Link to="/tokens" className="server-upload-link">
          API 토큰 발급/관리 →
        </Link>{' '}
        · 여러 파일·폴더는 저장소의 <code>scripts/fs-upload.sh</code> 사용
      </p>
    </div>
  )
}
