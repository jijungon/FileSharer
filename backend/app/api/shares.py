from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import get_settings
from ..deps import current_user, get_db
from ..models import ShareLink, User, utcnow
from ..services import audit
from ..services.permissions import get_node_checked
from ..services.shares import create_share, share_out

router = APIRouter(prefix="/api", tags=["shares"])


class CreateShareBody(BaseModel):
    days: int | None = None
    password: str | None = None
    max_downloads: int | None = None


@router.post("/nodes/{node_id}/shares", status_code=201)
def make_share(
    node_id: str,
    body: CreateShareBody,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> dict:
    node = get_node_checked(db, user, node_id)
    share, token = create_share(
        db,
        user,
        node,
        days=body.days,
        password=body.password or None,
        max_downloads=body.max_downloads,
    )
    audit.log(db, "share_create", user_id=user.id, node_id=node.id, detail=node.name)
    base = get_settings().base_url.rstrip("/")
    # 토큰은 이 응답에서 단 한 번만 노출된다 (DB에는 해시만 저장)
    return {
        **share_out(share),
        "token": token,
        "url": f"{base}/s/{token}",
        "get_command": f"curl -fsSL {base}/s/{token}/get | sh",
    }


@router.get("/nodes/{node_id}/shares")
def list_shares(
    node_id: str, user: User = Depends(current_user), db: Session = Depends(get_db)
) -> list[dict]:
    node = get_node_checked(db, user, node_id)
    shares = db.scalars(
        select(ShareLink)
        .where(ShareLink.node_id == node.id, ShareLink.revoked_at.is_(None))
        .order_by(ShareLink.created_at.desc())
    ).all()
    return [share_out(s) for s in shares]


@router.delete("/shares/{share_id}")
def revoke_share(
    share_id: str, user: User = Depends(current_user), db: Session = Depends(get_db)
) -> dict:
    share = db.get(ShareLink, share_id)
    if share is None:
        raise HTTPException(status_code=404, detail="링크가 없습니다")
    get_node_checked(db, user, share.node_id, include_deleted=True)
    share.revoked_at = utcnow()
    audit.log(db, "share_revoke", user_id=user.id, node_id=share.node_id)
    return {"ok": True}
