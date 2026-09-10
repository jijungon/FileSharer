from sqlalchemy.orm import Session

from ..models import AuditLog


def log(
    db: Session,
    action: str,
    *,
    user_id: str | None = None,
    node_id: str | None = None,
    detail: str = "",
) -> None:
    db.add(AuditLog(user_id=user_id, action=action, node_id=node_id, detail=detail[:500]))
