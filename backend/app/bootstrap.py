from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .config import get_settings
from .models import Space, User
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


def run_bootstrap(db: Session) -> None:
    """기동 시 1회: 전체(org) 공간 보장 + (설정 시) 최초 로컬 관리자 생성."""
    if db.scalar(select(Space).where(Space.type == "org")) is None:
        db.add(Space(type="org"))

    settings = get_settings()
    if settings.admin_email and settings.admin_password:
        exists = db.scalar(select(User).where(User.email == settings.admin_email.lower()))
        if exists is None and users_count(db) == 0:
            create_user(
                db,
                email=settings.admin_email,
                name="Admin",
                role="admin",
                password=settings.admin_password,
            )
    db.commit()
