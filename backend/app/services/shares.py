"""만료 공유 링크 — 토큰은 해시로만 저장, 만료/회수/횟수/비밀번호 검증."""

import base64
import hashlib
import secrets
from datetime import timedelta

from fastapi import HTTPException, Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import get_settings
from ..models import Node, ShareLink, User, as_utc, utcnow
from ..security import hash_password, verify_password


def _hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def create_share(
    db: Session,
    user: User,
    node: Node,
    *,
    days: int | None = None,
    password: str | None = None,
    max_downloads: int | None = None,
) -> tuple[ShareLink, str]:
    settings = get_settings()
    days = days or settings.share_default_days
    if not 1 <= days <= settings.share_max_days:
        raise HTTPException(
            status_code=422, detail=f"만료는 1~{settings.share_max_days}일 사이여야 합니다"
        )
    if max_downloads is not None and max_downloads < 1:
        raise HTTPException(status_code=422, detail="다운로드 횟수 제한은 1 이상이어야 합니다")

    token = secrets.token_urlsafe(32)
    share = ShareLink(
        node_id=node.id,
        token_hash=_hash_token(token),
        expires_at=utcnow() + timedelta(days=days),
        password_hash=hash_password(password) if password else None,
        max_downloads=max_downloads,
        created_by=user.id,
    )
    db.add(share)
    db.flush()
    return share, token


def share_out(share: ShareLink) -> dict:
    return {
        "id": share.id,
        "node_id": share.node_id,
        "expires_at": as_utc(share.expires_at).isoformat() if share.expires_at else None,
        "protected": share.password_hash is not None,
        "max_downloads": share.max_downloads,
        "download_count": share.download_count,
        "revoked": share.revoked_at is not None,
    }


def resolve_share(db: Session, token: str) -> tuple[ShareLink, Node]:
    """토큰 → (링크, 노드). 만료/회수/삭제는 410."""
    share = db.scalar(select(ShareLink).where(ShareLink.token_hash == _hash_token(token)))
    if share is None:
        raise HTTPException(status_code=404, detail="링크가 없습니다")
    if share.revoked_at is not None:
        raise HTTPException(status_code=410, detail="회수된 링크입니다")
    if as_utc(share.expires_at) < utcnow():
        raise HTTPException(status_code=410, detail="만료된 링크입니다")
    node = db.get(Node, share.node_id)
    if node is None or node.deleted_at is not None:
        raise HTTPException(status_code=410, detail="공유된 항목이 삭제되었습니다")
    return share, node


def check_password(request: Request, share: ShareLink) -> None:
    """비밀번호 링크: HTTP Basic(비밀번호 부분) 또는 X-Share-Password 헤더."""
    if share.password_hash is None:
        return
    supplied: str | None = request.headers.get("X-Share-Password")
    if supplied is None:
        auth = request.headers.get("Authorization", "")
        if auth.startswith("Basic "):
            try:
                decoded = base64.b64decode(auth[6:]).decode()
                supplied = decoded.split(":", 1)[1] if ":" in decoded else decoded
            except Exception:
                supplied = None
    if not supplied or not verify_password(supplied, share.password_hash):
        raise HTTPException(
            status_code=401,
            detail="비밀번호가 필요합니다",
            headers={"WWW-Authenticate": 'Basic realm="FileSharer share"'},
        )


def consume_download(db: Session, share: ShareLink) -> None:
    """다운로드 카운트 증가 — 한도 초과면 410."""
    if share.max_downloads is not None and share.download_count >= share.max_downloads:
        raise HTTPException(status_code=410, detail="다운로드 횟수를 초과한 링크입니다")
    share.download_count += 1
    db.flush()
