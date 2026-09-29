"""휴지통 보존 정책.

soft delete(deleted_at 설정)된 노드를 일정 기간 뒤 자동으로 완전삭제(purge)한다.
purge는 서브트리의 DB 행 + R2/로컬 blob + **그 노드를 가리키는 모든 행**을 제거한다.
"""

from __future__ import annotations

import logging
from collections.abc import Iterable
from datetime import datetime, timedelta

from sqlalchemy import delete as sql_delete
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import ApiToken, EditLock, Favorite, Node, NodeView, ShareLink, utcnow
from . import search_index
from .storage import StorageBackend

logger = logging.getLogger("filesharer")


def purge_subtree(db: Session, node: Node) -> tuple[int, list[str]]:
    """서브트리의 **DB 행만** 지운다. 반환: (지운 행 수, 지워진 파일들의 storage_key).

    **본체(blob)는 여기서 지우지 않는다.** 커밋이 끝난 뒤 호출자가 `delete_blobs` 로 치운다.

    순서가 중요하다. 예전에는 blob 을 먼저 지웠는데, 그 뒤 flush 가 실패하면 DB만
    롤백되고 **파일 본체는 이미 사라진 뒤였다** — 휴지통에 그대로 보이는데 복원하면
    알맹이가 없다. 실제로 그런 일이 있었다(FK 오류로 매번 실패하던 시절).
    지금 순서면 최악이 '참조 없는 오브젝트'이고, 그건 scripts/r2_orphans.py 로 치울 수
    있다. 사용자에게 보이는 손실보다 치울 수 있는 쓰레기가 낫다.
    """
    count = 0
    keys: list[str] = []
    children = db.scalars(select(Node).where(Node.parent_id == node.id)).all()
    for child in children:
        child_rows, child_keys = purge_subtree(db, child)
        count += child_rows
        keys.extend(child_keys)
    if node.type == "file" and node.storage_key:
        keys.append(node.storage_key)  # 지우는 건 커밋 뒤
    search_index.remove_node(db, node.id)  # 내용 검색 인덱스에서도 제거(영구삭제)
    # 이 노드를 가리키는 행을 **먼저 전부** 치운다. PRAGMA foreign_keys=ON 이라
    # 하나라도 남으면 FOREIGN KEY constraint failed 로 삭제 전체가 엎어진다.
    # 실제로 프로드에서 휴지통 자동삭제가 계속 실패했다 — 한 번이라도 열어본 파일이면
    # node_views 행이 남아 있기 때문이었다(사람은 열어보고 나서 지운다).
    # audit_log.node_id 는 일부러 FK가 아니다(기록은 노드가 사라져도 남아야 한다).
    for table, column in (
        (ShareLink, ShareLink.node_id),  # 공유 링크
        (Favorite, Favorite.node_id),  # 별표
        (NodeView, NodeView.node_id),  # 최근 열어본 항목
        (EditLock, EditLock.node_id),  # 편집 잠금
        (ApiToken, ApiToken.node_id),  # 이 노드로 범위를 좁힌 토큰
    ):
        db.execute(sql_delete(table).where(column == node.id))
    db.delete(node)
    return count + 1, keys


def delete_blobs(storage: StorageBackend, keys: Iterable[str]) -> int:
    """커밋이 끝난 뒤 파일 본체를 치운다. 반환: 실제로 지운 개수.

    하나가 실패해도 멈추지 않는다 — 여기서 멈추면 이미 DB에서 사라진 나머지의 본체가
    그대로 남는다. 남는 건 참조 없는 오브젝트라 r2_orphans.py 로 찾아 치울 수 있다.
    """
    removed = 0
    for key in keys:
        try:
            storage.delete(key)
            removed += 1
        except Exception:  # 저장소 장애가 이미 끝난 삭제를 되돌릴 수는 없다
            logger.warning("본체 삭제 실패 — 참조 없는 오브젝트로 남는다: %s", key)
    return removed


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
    keys: list[str] = []
    for nid in ids:
        node = db.get(Node, nid)
        if node is None:  # 상위 서브트리 purge로 이미 삭제됨
            continue
        rows, node_keys = purge_subtree(db, node)
        total += rows
        keys.extend(node_keys)
        db.flush()
    db.commit()
    delete_blobs(storage, keys)  # **커밋이 끝난 다음에만** 본체를 지운다
    return total
