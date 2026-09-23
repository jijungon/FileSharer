"""휴지통 보존 정책.

soft delete(deleted_at 설정)된 노드를 일정 기간 뒤 자동으로 완전삭제(purge)한다.
purge는 서브트리의 DB 행 + R2/로컬 blob + 공유 링크를 모두 제거한다.
"""

from __future__ import annotations

from datetime import datetime, timedelta

from sqlalchemy import delete as sql_delete
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import Node, ShareLink, utcnow
from . import search_index
from .storage import StorageBackend


def purge_subtree(db: Session, storage: StorageBackend, node: Node) -> int:
    """노드 서브트리를 영구 삭제 — blob·공유 링크·행 제거. 반환: 삭제 행 수."""
    count = 0
    children = db.scalars(select(Node).where(Node.parent_id == node.id)).all()
    for child in children:
        count += purge_subtree(db, storage, child)
    if node.type == "file" and node.storage_key:
        storage.delete(node.storage_key)
    search_index.remove_node(db, node.id)  # 내용 검색 인덱스에서도 제거(영구삭제)
    db.execute(sql_delete(ShareLink).where(ShareLink.node_id == node.id))
    db.delete(node)
    return count + 1


def purge_expired(
    db: Session,
    storage: StorageBackend,
    retention_days: int,
    now: datetime | None = None,
) -> int:
    """deleted_at이 retention_days를 넘긴 휴지통 항목을 완전삭제. 반환: 삭제된 총 행 수.

    휴지통에 들어간 노드(사용자가 지운 루트)만 대상으로 잡고, 그 서브트리는
    purge_subtree가 함께 지운다. 중첩 휴지통(부모·자식이 각각 휴지통) 상황에서도
    상위가 먼저 지워지면 하위는 이미 사라졌으므로 flush 후 재조회로 건너뛴다.
    """
    now = now or utcnow()
    cutoff = now - timedelta(days=retention_days)
    ids = [
        n.id
        for n in db.scalars(
            select(Node).where(Node.deleted_at.is_not(None), Node.deleted_at < cutoff)
        ).all()
    ]
    total = 0
    for nid in ids:
        node = db.get(Node, nid)
        if node is None:  # 상위 서브트리 purge로 이미 삭제됨
            continue
        total += purge_subtree(db, storage, node)
        db.flush()
    db.commit()
    return total
