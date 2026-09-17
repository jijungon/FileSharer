"""편집 잠금 — 텍스트/MD 문서를 한 번에 한 명만 편집(동시 수정 방지).

노드당 잠금 1개(EditLock.node_id = PK). 편집자는 주기적으로 하트비트(acquire 재호출)로
잠금을 갱신하고, 하트비트가 LOCK_TTL 넘게 끊기면(탭 닫힘·크래시) 만료로 보고 다른 사람이
인수한다. 실시간 동기화(Yjs 등) 없이 SQLite 레코드 + 하트비트만으로 동작한다.
"""

from datetime import timedelta

from sqlalchemy.orm import Session

from ..models import EditLock, as_utc, utcnow

# 이 시간 넘게 하트비트가 없으면 잠금 만료(인수 가능). 클라이언트 하트비트 주기(~10초)의
# 2~3배로 잡아 일시적 네트워크 지연엔 안 뺏기고, 탭을 닫으면 곧 풀리게 한다.
LOCK_TTL = timedelta(seconds=30)


def _is_fresh(lock: EditLock) -> bool:
    # SQLite는 tz를 버려 naive로 돌아오므로 as_utc로 보정한 뒤 비교한다.
    hb = as_utc(lock.heartbeat_at)
    return hb is not None and hb > utcnow() - LOCK_TTL


def get_active(db: Session, node_id: str) -> EditLock | None:
    """살아있는(만료되지 않은) 잠금만 반환. 만료된 잠금은 정리하고 None."""
    lock = db.get(EditLock, node_id)
    if lock is None:
        return None
    if _is_fresh(lock):
        return lock
    db.delete(lock)
    db.commit()
    return None


def acquire(db: Session, node_id: str, user_id: str) -> tuple[bool, EditLock]:
    """잠금 획득 또는 갱신(하트비트).

    반환: (내가 보유하게 됐는가, 현재 잠금). 남이 살아있는 잠금을 쥐고 있으면
    (False, 그 잠금)을 돌려준다. 내 잠금이거나 만료된 남의 잠금이면 인수/갱신 후 (True, 잠금).
    """
    now = utcnow()
    lock = db.get(EditLock, node_id)
    if lock is None:
        lock = EditLock(node_id=node_id, user_id=user_id, heartbeat_at=now)
        db.add(lock)
        db.commit()
        return True, lock
    if lock.user_id == user_id or not _is_fresh(lock):
        lock.user_id = user_id
        lock.heartbeat_at = now
        db.commit()
        return True, lock
    return False, lock


def release(db: Session, node_id: str, user_id: str) -> None:
    """내 잠금이면 해제(닫기). 남의 잠금은 건드리지 않는다."""
    lock = db.get(EditLock, node_id)
    if lock is not None and lock.user_id == user_id:
        db.delete(lock)
        db.commit()
