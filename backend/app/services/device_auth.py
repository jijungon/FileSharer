"""CLI 로그인 — 디바이스 플로우(RFC 8628).

터미널은 비밀번호를 받지 않는다. 대신 서버에서 코드 **한 쌍**을 받아, 사람이 읽을 쪽만
화면에 띄우고 나머지 한쪽을 쥔 채 승인을 기다린다. 사람은 이미 로그인된 브라우저에서
허용을 누른다. 터미널과 브라우저는 서로 직접 만나지 않는다 — 둘 다 서버만 본다.

그게 중요한 이유: 쓰는 사람은 대개 **SSH 로 들어간 VM** 에서 CLI 를 돌린다. 그 VM 엔
브라우저가 없고, 노트북 브라우저는 VM 의 localhost 에 닿을 수 없다. 흔한 localhost
콜백 방식이 거기선 아예 안 된다.
"""

import secrets
import time
from collections import defaultdict, deque
from datetime import timedelta

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import ApiToken, DeviceAuth, User, as_utc, new_id, utcnow
from ..security import hash_password, verify_password
from .tokens import create_token

# 사람이 옮겨 적는 코드의 자모. 헷갈리는 글자(0/O, 1/I/L)를 빼고, 모음도 빼서
# 우연히 말이 되는 조합(욕설 포함)이 안 나오게 한다.
_ALPHABET = "BCDFGHJKMNPQRSTVWXZ23456789"
USER_CODE_LEN = 8  # 27^8 ≈ 2.8e11 — 10분 수명 + 레이트리밋이면 추측으로 못 뚫는다

CODE_TTL_MIN = 10  # 승인 안 하면 10분 뒤 죽는다
POLL_INTERVAL_SEC = 5  # CLI 가 지켜야 할 간격. 더 빨리 물으면 slow_down
DEFAULT_TOKEN_DAYS = 90

_PREFIX = "fsd_"  # device_code 접두사(ApiToken 의 fsk_ 와 구분)

# 발급 자체를 막는 레이트리밋 — 이 엔드포인트는 **인증 없이** 열려 있다(디바이스 플로우는
# 원래 그렇다). auth.py 의 로그인 제한과 같은 방식: IP 당 10분에 20건.
_ISSUE_WINDOW_SEC, _ISSUE_MAX = 600, 20
_issues: dict[str, deque[float]] = defaultdict(deque)


class DeviceFlowError(HTTPException):
    """RFC 8628 의 에러 코드를 그대로 쓴다 — CLI 가 코드로 분기한다."""

    def __init__(self, code: str, status_code: int = 400):
        super().__init__(status_code=status_code, detail={"error": code})
        self.code = code


def new_user_code() -> str:
    raw = "".join(secrets.choice(_ALPHABET) for _ in range(USER_CODE_LEN))
    return f"{raw[:4]}-{raw[4:]}"  # XXXX-XXXX 로 끊어 읽기 쉽게


def _split(raw: str) -> tuple[str | None, str]:
    """``fsd_<id>.<secret>`` → (id, secret). 모양이 아니면 (None, 원문)."""
    if not raw.startswith(_PREFIX):
        return None, raw
    body = raw[len(_PREFIX) :]
    head, sep, secret = body.partition(".")
    if not sep or not head:
        return None, raw
    return head, secret


def issue_rate_limited(ip: str) -> bool:
    now = time.monotonic()
    q = _issues[ip]
    while q and now - q[0] > _ISSUE_WINDOW_SEC:
        q.popleft()
    if len(q) >= _ISSUE_MAX:
        return True
    q.append(now)
    return False


def start(db: Session, *, client_name: str, client_ip: str) -> tuple[DeviceAuth, str]:
    """코드 한 쌍 발급 → (행, device_code 원문). 원문은 여기서만 나온다."""
    row_id = new_id()
    secret = secrets.token_urlsafe(32)
    row = DeviceAuth(
        id=row_id,
        code_hash=hash_password(secret),
        user_code=new_user_code(),
        status="pending",
        client_name=(client_name or "").strip()[:120],
        client_ip=(client_ip or "")[:64],
        expires_at=utcnow() + timedelta(minutes=CODE_TTL_MIN),
    )
    db.add(row)
    db.flush()
    return row, f"{_PREFIX}{row_id}.{secret}"


def find_pending(db: Session, user_code: str) -> DeviceAuth:
    """승인 화면이 user_code 로 건을 찾는다. 없거나 만료면 404."""
    code = (user_code or "").strip().upper().replace(" ", "")
    if len(code) == USER_CODE_LEN and "-" not in code:  # 사람이 하이픈을 빼고 칠 수 있다
        code = f"{code[:4]}-{code[4:]}"
    row = db.scalar(select(DeviceAuth).where(DeviceAuth.user_code == code))
    if row is None:
        raise HTTPException(status_code=404, detail="그런 코드가 없습니다")
    if row.status != "pending":
        raise HTTPException(status_code=409, detail="이미 처리된 코드입니다")
    if as_utc(row.expires_at) < utcnow():
        raise HTTPException(
            status_code=410, detail="코드가 만료됐습니다 — 터미널에서 다시 시도하세요"
        )
    return row


def approve(
    db: Session,
    row: DeviceAuth,
    user: User,
    *,
    space_id: str | None,
    node_id: str | None,
    token_days: int,
) -> None:
    """승인 — **토큰은 아직 만들지 않는다.**

    원문은 생성 때 한 번만 나오는데 그걸 받아갈 CLI 는 그 뒤에 폴링하러 온다. 중간에
    어딘가 적어두면 해싱이 의미를 잃으므로, 여기선 '허락했다' 와 범위만 남긴다.
    """
    row.status = "approved"
    row.user_id = user.id
    row.space_id = space_id
    row.node_id = node_id
    row.token_days = token_days
    row.approved_at = utcnow()


def deny(db: Session, row: DeviceAuth) -> None:
    row.status = "denied"


def poll(db: Session, device_code: str) -> tuple[ApiToken, str]:
    """CLI 의 폴링. 승인됐으면 **여기서** 토큰을 만들어 원문째 건넨다.

    아니면 RFC 8628 의 에러 코드를 돌려준다:
    ``authorization_pending`` · ``slow_down`` · ``expired_token`` · ``access_denied``.
    """
    row_id, secret = _split(device_code or "")
    row = db.get(DeviceAuth, row_id) if row_id else None
    if row is None or not verify_password(secret, row.code_hash):
        # 없는 id 에도 해시 검증을 돌려 타이밍을 균일하게(tokens.resolve_token 과 같은 이유)
        if row is None:
            verify_password(secret or "x", hash_password("x"))
        raise DeviceFlowError("invalid_grant", status_code=401)

    # 너무 자주 물으면 간격을 늘려 돌려보낸다(서버 보호 + RFC 권고).
    #
    # **여기서 바로 커밋하는 이유**: 폴링의 정상 응답은 에러다(authorization_pending).
    # 이 앱은 성공 응답에서만 커밋하므로(deps.get_db), 그냥 두면 방금 찍은 시각이
    # 롤백돼 사라진다 — 간격 제한이 통째로 죽는다. 실제로 그렇게 짜서 테스트가 잡았다.
    now = utcnow()
    if row.last_polled_at is not None:
        since = (now - as_utc(row.last_polled_at)).total_seconds()
        if since < POLL_INTERVAL_SEC:
            raise DeviceFlowError("slow_down")
    row.last_polled_at = now
    db.commit()

    if row.status == "denied":
        raise DeviceFlowError("access_denied")
    if row.status == "consumed":
        # 한 번 쓰면 끝. 같은 device_code 로 토큰을 또 받아갈 수 없다.
        raise DeviceFlowError("invalid_grant", status_code=401)
    if as_utc(row.expires_at) < utcnow():
        raise DeviceFlowError("expired_token")
    if row.status != "approved":
        raise DeviceFlowError("authorization_pending")

    user = db.get(User, row.user_id) if row.user_id else None
    if user is None or not user.is_active:
        raise DeviceFlowError("access_denied")

    token, plaintext = create_token(
        db,
        user,
        label=row.client_name or "CLI",
        space_id=row.space_id,
        node_id=row.node_id,
        expires_in_days=row.token_days,
    )
    row.status = "consumed"
    return token, plaintext


def purge_expired(db: Session) -> int:
    """만료된 pending 건 청소. 쌓아둘 이유가 없다."""
    rows = db.scalars(
        select(DeviceAuth).where(
            DeviceAuth.status.in_(("pending", "denied")), DeviceAuth.expires_at < utcnow()
        )
    ).all()
    for row in rows:
        db.delete(row)
    return len(rows)
