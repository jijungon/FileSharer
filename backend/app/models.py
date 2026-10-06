import uuid
from datetime import UTC, datetime

from sqlalchemy import DateTime, ForeignKey, Integer, String, UniqueConstraint
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


def new_id() -> str:
    return uuid.uuid4().hex


def utcnow() -> datetime:
    return datetime.now(UTC)


def as_utc(dt: datetime | None) -> datetime | None:
    """SQLite는 tz를 버리므로, naive로 돌아온 값을 UTC로 간주해 보정한다."""
    if dt is None:
        return None
    return dt.replace(tzinfo=UTC) if dt.tzinfo is None else dt


def email_nickname(email: str) -> str:
    """표시용 닉네임 = 이메일 @ 앞부분(joji@parametacorp.com → joji). @ 없으면 원문."""
    return email.split("@", 1)[0] or email


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
    # 업로드 때 저장 — 원격 스토리지에서 체크섬 재다운로드 방지
    sha256: Mapped[str] = mapped_column(String(64), default="")
    created_by: Mapped[str] = mapped_column(ForeignKey("users.id"))
    # 마지막으로 바꾼 사람(저장·리네임·이동). 신규 업로드 직후엔 없어 표시상 created_by로 폴백.
    updated_by: Mapped[str | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True, index=True)

    # 표시용(업로더·수정자 닉네임). selectin으로 배치 로드해 N+1 회피, 읽기 전용.
    creator: Mapped["User | None"] = relationship(
        "User", foreign_keys=[created_by], lazy="selectin", viewonly=True
    )
    editor: Mapped["User | None"] = relationship(
        "User", foreign_keys=[updated_by], lazy="selectin", viewonly=True
    )


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

    # 링크를 여러 개 만들면 목록이 "joji · 10-01 발급 · ~10-08 만료" 로 전부 똑같아져
    # **어느 걸 회수할지 알 수 없다.** 두 가지로 가른다:
    #
    #   label  — 사람이 적는 한 줄("박대리님", "협력사 전달"). 본질적인 해결이다.
    #   token_prefix — 토큰 앞자리. 메모를 안 적었어도 구분은 되고, 무엇보다 **보낸
    #            주소와 눈으로 맞춰볼 수 있다**(.../s/IVvfDn… 의 그 앞자리다).
    #
    # 접두사를 따로 두는 이유: 토큰 원문은 해시로만 저장해 복원할 수 없다. 앞 8자를
    # 드러내도 남는 35자(≈208비트)로는 추측이 불가능하고, 이 목록을 볼 수 있는 사람은
    # 애초에 발급 직후 원문을 본 사람이다.
    label: Mapped[str] = mapped_column(String(120), default="")
    token_prefix: Mapped[str] = mapped_column(String(12), default="")

    # 표시용(누가 발급했는지). Node.creator 와 같은 방식 — 배치 로드·읽기 전용.
    creator: Mapped["User | None"] = relationship(
        "User", foreign_keys=[created_by], lazy="selectin", viewonly=True
    )


class ApiToken(Base):
    """서버(헤드리스) 업로드용 API 토큰. 원문은 절대 저장하지 않는다 —
    토큰은 `fsk_<id>.<secret>` 형태이고, id(=이 행 PK)로 조회한 뒤 secret만
    scrypt 해시(token_hash)로 상수시간 검증한다. services/tokens.py 참고.

    범위(scope): node_id가 있으면 그 폴더(및 하위)로만, 없고 space_id가 있으면
    그 공간 전체로, 둘 다 없으면(null scope) 소유자의 개인 공간으로만 업로드 가능.
    """

    __tablename__ = "api_tokens"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    label: Mapped[str] = mapped_column(String(120), default="")
    # secret 부분만 scrypt로 해시해 저장(원문·id는 저장 안 함). security.hash_password 재사용.
    token_hash: Mapped[str] = mapped_column(String(255))
    # 범위 제한(선택). null이면 소유자 개인 공간으로만 제한(안전한 기본값).
    space_id: Mapped[str | None] = mapped_column(ForeignKey("spaces.id"), nullable=True)
    node_id: Mapped[str | None] = mapped_column(ForeignKey("nodes.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    expires_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class DeviceAuth(Base):
    """CLI 로그인(디바이스 플로우, RFC 8628)의 한 번짜리 승인 건.

    터미널과 브라우저가 **서로 못 만나도** 되게 하는 게 요점이다. 둘 다 서버만 본다 —
    SSH 로 들어간 VM 에서 CLI 를 돌리면 노트북 브라우저는 그 VM 의 localhost 에 닿을 수
    없으므로, 흔한 localhost 콜백 방식은 아예 쓸 수 없다.

    코드를 **둘로 가르는** 이유: ``user_code`` 는 사람이 눈으로 옮기는 짧은 코드고,
    ``device_code`` 는 터미널만 아는 긴 비밀값이다. 남이 user_code 를 어깨너머로 봐도
    토큰은 못 받아간다 — 받으려면 device_code 가 있어야 한다.

    ``device_code`` 는 ``fsd_<id>.<secret>`` 꼴이고 secret 만 해시로 둔다(ApiToken 과 같은 방식).

    승인 시점에 토큰을 만들지 **않는다**. 원문은 생성 때 한 번만 나오는데, 그걸 받아갈
    CLI 는 그 뒤에 폴링하러 온다 — 중간에 어딘가 적어두면 해싱이 의미를 잃는다.
    그래서 승인은 '허락했다'만 남기고, **토큰은 폴링이 왔을 때 만들어 그 자리에서 건넨다.**
    """

    __tablename__ = "device_auths"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    # device_code 의 secret 부분만 scrypt 해시로(원문·id 는 저장 안 함)
    code_hash: Mapped[str] = mapped_column(String(255))
    # 사람이 옮겨 적는 코드. 헷갈리는 글자(0/O, 1/I/L)와 모음을 뺀 자모로 만든다.
    user_code: Mapped[str] = mapped_column(String(16), index=True)
    # pending → approved → consumed, 또는 denied
    status: Mapped[str] = mapped_column(String(16), default="pending", index=True)
    # 승인 전엔 비어 있다 — 누가 승인했는지가 곧 토큰의 주인이 된다
    user_id: Mapped[str | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    # 승인 화면에 그대로 보여줄 것들. 피싱("이 코드 좀 넣어주세요")을 사람이 알아채려면
    # **무엇을 승인하는지** 가 눈에 보여야 한다.
    client_name: Mapped[str] = mapped_column(String(120), default="")
    client_ip: Mapped[str] = mapped_column(String(64), default="")
    # 승인된 범위(토큰에 그대로 넘어간다)
    space_id: Mapped[str | None] = mapped_column(ForeignKey("spaces.id"), nullable=True)
    node_id: Mapped[str | None] = mapped_column(ForeignKey("nodes.id"), nullable=True)
    token_days: Mapped[int] = mapped_column(Integer, default=90)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    expires_at: Mapped[datetime] = mapped_column(DateTime)
    approved_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    # 폴링 간격(slow_down) 판정용 — 너무 자주 물으면 간격을 늘려 돌려보낸다
    last_polled_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class Favorite(Base):
    """사용자별 즐겨찾기(별표). (user_id, node_id) 유일."""

    __tablename__ = "favorites"
    __table_args__ = (UniqueConstraint("user_id", "node_id", name="uq_favorite_user_node"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    node_id: Mapped[str] = mapped_column(ForeignKey("nodes.id"), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class NodeView(Base):
    """사용자별 '최근 열어본 항목'. (user_id, node_id) 유일, 열 때마다 viewed_at 갱신."""

    __tablename__ = "node_views"
    __table_args__ = (UniqueConstraint("user_id", "node_id", name="uq_nodeview_user_node"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    node_id: Mapped[str] = mapped_column(ForeignKey("nodes.id"), index=True)
    viewed_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, index=True)


class AuditLog(Base):
    __tablename__ = "audit_log"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[str | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    action: Mapped[str] = mapped_column(String(40), index=True)
    node_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, index=True)
    detail: Mapped[str] = mapped_column(String(500), default="")


class EditLock(Base):
    """텍스트/MD 편집 잠금 — 한 노드는 한 번에 한 명만 편집(동시 수정 방지).
    node_id가 곧 PK(노드당 잠금 1개). heartbeat_at이 LOCK_TTL 넘게 오래되면
    만료로 보고(브라우저 닫힘·크래시 대비) 다른 사람이 인수할 수 있다. services/locks.py 참고."""

    __tablename__ = "edit_locks"

    node_id: Mapped[str] = mapped_column(ForeignKey("nodes.id"), primary_key=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    heartbeat_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, index=True)
