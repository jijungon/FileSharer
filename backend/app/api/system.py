"""관리자 시스템 API — 감사 로그, 디스크 사용률, 휴지통 영구 삭제, 백업 상태."""

import logging
import shutil
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import get_settings
from ..deps import current_user, get_db, require_admin
from ..models import AuditLog, User
from ..services import audit
from ..services import backup as backup_svc
from ..services.permissions import get_node_checked
from ..services.storage import build_storage, storage_usage
from ..services.trash import delete_blobs, purge_subtree

router = APIRouter(prefix="/api/system", tags=["system"])
logger = logging.getLogger("filesharer")


@router.get("/backup")
def backup_status(user: User = Depends(current_user)) -> dict:
    """마지막 백업 회차 — 화면 상단 배지가 "정말 돌고 있나"를 보여주는 데 쓴다.

    **로그인한 사람 모두**가 본다. "내 파일이 언제 백업됐나"는 관리자만의 관심사가 아니다.
    다만 규모(공간·파일 수·용량)는 **자기가 못 보는 공간의 크기까지 드러내므로** 관리자에게만.
    """
    settings = get_settings()
    if not settings.backup_enabled:
        return {"enabled": False, "last": None}
    try:
        last = backup_svc.latest_summary(backup_svc.build_backup_store(settings))
    except Exception:  # 저장소가 잠깐 말썽이어도 화면이 깨지면 안 된다
        logger.exception("백업 상태 조회 실패")
        return {"enabled": True, "last": None, "unavailable": True}
    if last and user.role != "admin":
        last = {key: last[key] for key in ("kind", "stamp", "created_at")}
    return {"enabled": True, "last": last}


@router.get("/disk")
def disk_usage(_: User = Depends(require_admin)) -> dict:
    """서버 디스크 + **저장소** 사용량.

    R2를 쓰면 파일 본체가 서버에 없어서 디스크만 보여주면 "파일 본체 0 B"로 뜬다 —
    파일이 없다는 뜻으로 읽히지만 실제로는 다른 곳에 있다는 뜻이다. 그래서 둘을 나눠서 준다.
    """
    settings = get_settings()
    data_dir = Path(settings.data_dir)
    usage = shutil.disk_usage(data_dir)
    blobs = data_dir / "blobs"
    blob_bytes = sum(f.stat().st_size for f in blobs.glob("*") if f.is_file())
    used_ratio = usage.used / usage.total if usage.total else 0.0
    try:
        storage = storage_usage(build_storage(settings))
    except Exception:  # 저장소가 잠깐 말썽이어도 관리 화면이 깨지면 안 된다
        logger.exception("저장소 사용량 조회 실패")
        storage = None
    return {
        "total": usage.total,
        "used": usage.used,
        "free": usage.free,
        "used_ratio": round(used_ratio, 4),
        "blob_bytes": blob_bytes,
        "warn": used_ratio >= settings.disk_warn_ratio,
        "warn_ratio": settings.disk_warn_ratio,
        "storage": storage,
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
    storage = build_storage(get_settings())
    name = node.name  # 행을 지우고 나면 못 읽는다
    removed, keys = purge_subtree(db, node)
    audit.log(db, "purge", user_id=admin.id, node_id=node_id, detail=f"{name} ({removed})")
    db.commit()  # DB를 먼저 확정하고 본체를 지운다
    delete_blobs(storage, keys)
    return {"ok": True, "removed": removed}
