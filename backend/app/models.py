import uuid
from datetime import UTC, datetime

from sqlalchemy import DateTime, ForeignKey, Integer, String, UniqueConstraint
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


def new_id() -> str:
    return uuid.uuid4().hex


def utcnow() -> datetime:
    return datetime.now(UTC)


def as_utc(dt: datetime | None) -> datetime | None:
    """SQLite는 tz를 버리므로, naive로 돌아온 값을 UTC로 간주해 보정한다."""
    if dt is None:
        return None
    return dt.replace(tzinfo=UTC) if dt.tzinfo is None else dt


class Base(DeclarativeBase):
    pass


class User(Base):
    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    email: Mapped[str] = mapped_column(String(255), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(120), default="")
    # 구글 전용 계정은 빈 값 — 로컬 로그인 불가
    password_hash: Mapped[str] = mapped_column(String(255), default="")
    role: Mapped[str] = mapped_column(String(16), default="member")  # admin | member
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    disabled_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    @property
    def is_admin(self) -> bool:
        return self.role == "admin"

    @property
    def is_active(self) -> bool:
        return self.disabled_at is None


class Team(Base):
    __tablename__ = "teams"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    name: Mapped[str] = mapped_column(String(120), unique=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class TeamMember(Base):
    __tablename__ = "team_members"
    __table_args__ = (UniqueConstraint("team_id", "user_id"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    team_id: Mapped[str] = mapped_column(ForeignKey("teams.id"), index=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)


class Space(Base):
    """권한의 단위: personal(user_id) / team(team_id) / org (단일)."""

    __tablename__ = "spaces"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    type: Mapped[str] = mapped_column(String(16), index=True)  # personal | team | org
    user_id: Mapped[str | None] = mapped_column(ForeignKey("users.id"), nullable=True, index=True)
    team_id: Mapped[str | None] = mapped_column(ForeignKey("teams.id"), nullable=True, index=True)


class Node(Base):
    """폴더/파일 트리. 파일 본체는 DATA_DIR/blobs/<storage_key>."""

    __tablename__ = "nodes"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    space_id: Mapped[str] = mapped_column(ForeignKey("spaces.id"), index=True)
    parent_id: Mapped[str | None] = mapped_column(ForeignKey("nodes.id"), nullable=True, index=True)
    type: Mapped[str] = mapped_column(String(8))  # folder | file
    name: Mapped[str] = mapped_column(String(255))  # NFC 정규화된 표시명
    size: Mapped[int] = mapped_column(Integer, default=0)
    mime: Mapped[str] = mapped_column(String(127), default="")
    storage_key: Mapped[str] = mapped_column(String(64), default="")
    created_by: Mapped[str] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True, index=True)


class ShareLink(Base):
    __tablename__ = "share_links"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    node_id: Mapped[str] = mapped_column(ForeignKey("nodes.id"), index=True)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime)
    password_hash: Mapped[str | None] = mapped_column(String(255), nullable=True)
    max_downloads: Mapped[int | None] = mapped_column(Integer, nullable=True)
    download_count: Mapped[int] = mapped_column(Integer, default=0)
    created_by: Mapped[str] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class AuditLog(Base):
    __tablename__ = "audit_log"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[str | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    action: Mapped[str] = mapped_column(String(40), index=True)
    node_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, index=True)
    detail: Mapped[str] = mapped_column(String(500), default="")
