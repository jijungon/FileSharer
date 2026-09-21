"""서버(헤드리스) 업로드용 API 토큰 — 원문은 저장하지 않고 secret만 scrypt로 해시.

토큰 형식: ``fsk_<token_id>.<secret>``
  * ``token_id`` = ApiToken 행의 PK(공개 식별자). 조회용 — 비밀이 아니다.
  * ``secret``   = 고엔트로피 난수(urlsafe base64). 이것만 scrypt(token_hash)로 저장한다.

검증은 id로 행을 찾은 뒤 ``verify_password``(내부적으로 ``hmac.compare_digest`` — 상수시간)로
secret을 비교한다. 즉 "해시로만 저장 + 상수시간 비교"를 만족하면서, 임의 salt를 쓰는
scrypt로도 O(1) 조회가 가능하다. 토큰 원문은 로그·URL·에러 메시지에 절대 넣지 않는다.
"""

import secrets
from datetime import timedelta
from functools import lru_cache

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import ApiToken, Space, User, as_utc, new_id, utcnow
from ..security import hash_password, verify_password
from .permissions import is_descendant

TOKEN_PREFIX = "fsk_"  # FileSharer key. 시크릿 스캐너가 잡아내기 쉽게 고정 접두어를 붙인다.
_MAX_EXPIRES_DAYS = 365


@lru_cache(maxsize=1)
def _dummy_hash() -> str:
    """존재하지 않는 토큰에도 동일 비용의 검증을 수행해 타이밍 오라클을 없애기 위한 더미.
    실제 비밀이 아니라 상수시간 균일화용 고정 문자열이다."""
    return hash_password("api-token-timing-equalizer")


def _split(raw: str) -> tuple[str | None, str]:
    """``fsk_<id>.<secret>`` → (id, secret). 형식이 아니면 (None, "")."""
    if not raw or not raw.startswith(TOKEN_PREFIX):
        return None, ""
    body = raw[len(TOKEN_PREFIX):]
    token_id, sep, secret = body.partition(".")
    if not sep or not token_id or not secret:
        return None, ""
    return token_id, secret


def create_token(
    db: Session,
    user: User,
    *,
    label: str = "",
    space_id: str | None = None,
    node_id: str | None = None,
    expires_in_days: int | None = None,
) -> tuple[ApiToken, str]:
    """토큰 생성 → (행, 원문). 원문(plaintext)은 이 반환값에서 단 한 번만 노출된다."""
    if expires_in_days is not None and not 1 <= expires_in_days <= _MAX_EXPIRES_DAYS:
        raise HTTPException(
            status_code=422, detail=f"만료는 1~{_MAX_EXPIRES_DAYS}일 사이여야 합니다"
        )
    token_id = new_id()
    secret = secrets.token_urlsafe(32)
    token = ApiToken(
        id=token_id,
        user_id=user.id,
        label=(label or "").strip()[:120],
        token_hash=hash_password(secret),
        space_id=space_id,
        node_id=node_id,
        expires_at=(utcnow() + timedelta(days=expires_in_days)) if expires_in_days else None,
    )
    db.add(token)
    db.flush()
    plaintext = f"{TOKEN_PREFIX}{token_id}.{secret}"
    return token, plaintext


def resolve_token(db: Session, raw: str) -> ApiToken:
    """Bearer 원문 → 유효한 ApiToken. 무효/회수/만료면 401.
    존재하지 않는 id에도 더미 해시로 상수시간 검증을 수행한다."""
    token_id, secret = _split(raw)
    row = db.get(ApiToken, token_id) if token_id else None
    if row is None:
        verify_password(secret or "x", _dummy_hash())  # 타이밍 균일화
        raise HTTPException(status_code=401, detail="유효하지 않은 토큰입니다")
    if not verify_password(secret, row.token_hash):
        raise HTTPException(status_code=401, detail="유효하지 않은 토큰입니다")
    if row.revoked_at is not None:
        raise HTTPException(status_code=401, detail="회수된 토큰입니다")
    if row.expires_at is not None and as_utc(row.expires_at) < utcnow():
        raise HTTPException(status_code=401, detail="만료된 토큰입니다")
    return row


def enforce_scope(db: Session, token: ApiToken, space: Space, parent_id: str | None) -> None:
    """토큰이 이 대상(space + parent 폴더)에 업로드할 수 있는지 검사. 범위 밖이면 403.

    * node_id 범위: parent가 그 폴더이거나 하위여야 한다(루트 업로드 불가).
    * space_id 범위: 대상 공간이 그 공간이어야 한다.
    * null 범위: 소유자 개인 공간이어야 한다(안전한 기본값).
    """
    if token.node_id:
        if parent_id is None or not is_descendant(db, parent_id, token.node_id):
            raise HTTPException(status_code=403, detail="토큰 범위 밖의 위치입니다")
        return
    if token.space_id:
        if space.id != token.space_id:
            raise HTTPException(status_code=403, detail="토큰 범위 밖의 공간입니다")
        return
    personal = db.scalar(
        select(Space).where(Space.type == "personal", Space.user_id == token.user_id)
    )
    if personal is None or space.id != personal.id:
        raise HTTPException(status_code=403, detail="토큰 범위 밖의 공간입니다")
