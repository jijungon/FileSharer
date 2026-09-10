"""관리자 시스템 API — 감사 로그, 디스크 사용률, 휴지통 영구 삭제."""

import shutil
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import delete as sql_delete
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import get_settings
from ..deps import get_db, require_admin
from ..models import AuditLog, Node, ShareLink, User
from ..services import audit
from ..services.permissions import get_node_checked
from ..services.storage import LocalStorage

router = APIRouter(prefix="/api/system", tags=["system"])


@router.get("/disk")
def disk_usage(_: User = Depends(require_admin)) -> dict:
    settings = get_settings()
    data_dir = Path(settings.data_dir)
    usage = shutil.disk_usage(data_dir)
    blobs = data_dir / "blobs"
    blob_bytes = sum(f.stat().st_size for f in blobs.glob("*") if f.is_file())
    used_ratio = usage.used / usage.total if usage.total else 0.0
    return {
        "total": usage.total,
        "used": usage.used,
        "free": usage.free,
        "used_ratio": round(used_ratio, 4),
        "blob_bytes": blob_bytes,
        "warn": used_ratio >= settings.disk_warn_ratio,
        "warn_ratio": settings.disk_warn_ratio,
    }


@router.get("/audit")
def audit_log(
    limit: int = 100,
    action: str | None = None,
    _: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> list[dict]:
    limit = max(1, min(limit, 500))
    q = (
        select(AuditLog, User.email)
        .join(User, User.id == AuditLog.user_id, isouter=True)
        .order_by(AuditLog.at.desc())
        .limit(limit)
    )
    if action:
        q = q.where(AuditLog.action == action)
    rows = db.execute(q).all()
    return [
        {
            "id": entry.id,
            "at": entry.at.isoformat() if entry.at else None,
            "action": entry.action,
            "user": email or "(비로그인)",
            "node_id": entry.node_id,
            "detail": entry.detail,
        }
        for entry, email in rows
    ]


def _purge_subtree(db: Session, storage: LocalStorage, node: Node) -> int:
    """노드 서브트리를 영구 삭제 — blob·공유 링크·행 제거. 반환: 삭제 행 수."""
    count = 0
    children = db.scalars(select(Node).where(Node.parent_id == node.id)).all()
    for child in children:
        count += _purge_subtree(db, storage, child)
    if node.type == "file" and node.storage_key:
        storage.delete(node.storage_key)
    db.execute(sql_delete(ShareLink).where(ShareLink.node_id == node.id))
    db.delete(node)
    return count + 1


@router.delete("/nodes/{node_id}/purge")
def purge_node(
    node_id: str,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> dict:
    # 관리자이면서 그 공간에 접근 가능한 경우만 (남의 개인 공간은 프라이버시 원칙상 불가)
    node = get_node_checked(db, admin, node_id, include_deleted=True)
    if node.deleted_at is None:
        raise HTTPException(status_code=400, detail="휴지통에 있는 항목만 영구 삭제할 수 있습니다")
    storage = LocalStorage(get_settings().data_dir)
    removed = _purge_subtree(db, storage, node)
    audit.log(db, "purge", user_id=admin.id, node_id=node_id, detail=f"{node.name} ({removed})")
    return {"ok": True, "removed": removed}
