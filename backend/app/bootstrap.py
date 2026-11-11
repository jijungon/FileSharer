from datetime import timedelta

from sqlalchemy import delete as sql_delete
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from .config import get_settings
from .models import ShareLink, Space, User, utcnow
from .security import hash_password


def ensure_personal_space(db: Session, user: User) -> Space:
    space = db.scalar(select(Space).where(Space.type == "personal", Space.user_id == user.id))
    if space is None:
        space = Space(type="personal", user_id=user.id)
        db.add(space)
        db.flush()
    return space


def create_user(
    db: Session,
    *,
    email: str,
    name: str = "",
    role: str = "member",
    password: str | None = None,
) -> User:
    """사용자 생성 + 개인 공간 자동 생성 (로컬/구글 프로비저닝 공용)."""
    user = User(
        email=email.lower().strip(),
        name=name,
        role=role,
        password_hash=hash_password(password) if password else "",
    )
    db.add(user)
    db.flush()
    ensure_personal_space(db, user)
    return user


def users_count(db: Session) -> int:
    return db.scalar(select(func.count()).select_from(User)) or 0


def cleanup_stale_shares(db: Session) -> int:
    """만료/회수 후 90일 지난 공유 링크 행 정리 (기동 시 하우스키핑)."""
    cutoff = utcnow() - timedelta(days=90)
    result = db.execute(
        sql_delete(ShareLink).where(
            or_(ShareLink.expires_at < cutoff, ShareLink.revoked_at < cutoff)
        )
    )
    return result.rowcount or 0


def run_bootstrap(db: Session) -> None:
    """기동 시 1회: 전체(org) 공간 보장 + 최초 로컬 관리자 생성 + 링크 정리.

    로컬 관리자는 비밀번호 로그인이 켜진 곳(테스트·개발)에서만 만든다."""
    if db.scalar(select(Space).where(Space.type == "org")) is None:
        db.add(Space(type="org"))

    settings = get_settings()
    # 비밀번호 로그인이 꺼진 곳(운영)에선 비밀번호 관리자를 만들지 않는다 — 못 쓰는 계정이
    # 관리자 수만 채운다. 그런 곳의 첫 관리자는 구글로 처음 로그인한 사람이다.
    if settings.local_login_enabled and settings.admin_email and settings.admin_password:
        exists = db.scalar(select(User).where(User.email == settings.admin_email.lower()))
        if exists is None and users_count(db) == 0:
            create_user(
                db,
                email=settings.admin_email,
                name="Admin",
                role="admin",
                password=settings.admin_password,
            )
    cleanup_stale_shares(db)
    db.commit()
