"""API 토큰 관리 — 로그인한 사용자가 '자기' 토큰을 발급/조회/회수한다(세션 인증).

토큰 원문은 생성 응답에서 단 한 번만 노출되고(DB엔 해시만), 목록/조회에는 절대 담기지 않는다.
"""

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..deps import current_user, get_db
from ..models import ApiToken, Node, Space, Team, User, as_utc, utcnow
from ..services import audit
from ..services.permissions import get_node_checked, get_space_checked
from ..services.tokens import create_token

router = APIRouter(prefix="/api/tokens", tags=["tokens"])


class CreateTokenBody(BaseModel):
    label: str = ""
    space_id: str | None = None
    node_id: str | None = None
    expires_in_days: int | None = None
    expires_in_minutes: int | None = None  # 서버 업로드용 짧은 임시 토큰(분 단위). days보다 우선.


def _space_label(db: Session, space: Space) -> str:
    if space.type == "personal":
        return "내 공간"
    if space.type == "org":
        return "전체 공간"
    team = db.get(Team, space.team_id) if space.team_id else None
    return team.name if team else "팀 공간"


def _scope_label(db: Session, token: ApiToken) -> str:
    """사람이 읽는 범위 설명."""
    if token.node_id:
        node = db.get(Node, token.node_id)
        return f"폴더: {node.name}" if node else "폴더(삭제됨)"
    if token.space_id:
        space = db.get(Space, token.space_id)
        return _space_label(db, space) if space else "공간(삭제됨)"
    return "내 공간(기본)"


def _iso(dt) -> str | None:
    return as_utc(dt).isoformat() if dt else None


def _token_out(db: Session, token: ApiToken) -> dict:
    return {
        "id": token.id,
        "label": token.label,
        "space_id": token.space_id,
        "node_id": token.node_id,
        "scope_label": _scope_label(db, token),
        "created_at": _iso(token.created_at),
        "last_used_at": _iso(token.last_used_at),
        "expires_at": _iso(token.expires_at),
    }


@router.post("", status_code=201)
def create(
    body: CreateTokenBody, user: User = Depends(current_user), db: Session = Depends(get_db)
) -> dict:
    """토큰 발급. 범위(space_id 또는 폴더 node_id)는 발급자가 접근 가능한 곳이어야 한다.
    둘 다 없으면 발급자 개인 공간으로만 제한한다(안전한 기본값)."""
    space_id: str | None = None
    node_id: str | None = None
    if body.node_id:
        node = get_node_checked(db, user, body.node_id)  # 존재 + 접근 권한 검사
        if node.type != "folder":
            raise HTTPException(status_code=422, detail="폴더만 범위로 지정할 수 있습니다")
        node_id = node.id
    elif body.space_id:
        space = get_space_checked(db, user, body.space_id)
        space_id = space.id
    # else: null scope → 개인 공간(생성 시 저장 안 함, 사용 시 해석)

    token, plaintext = create_token(
        db,
        user,
        label=body.label,
        space_id=space_id,
        node_id=node_id,
        expires_in_days=body.expires_in_days,
        expires_in_minutes=body.expires_in_minutes,
    )
    audit.log(db, "token_create", user_id=user.id, detail=token.label or token.id)
    return {
        **_token_out(db, token),
        # 원문은 여기서만 반환된다 — 다시 볼 수 없다.
        "token": plaintext,
        "warning": "이 토큰은 지금만 표시됩니다. 안전한 곳에 보관하세요.",
    }


@router.get("")
def list_tokens(
    user: User = Depends(current_user), db: Session = Depends(get_db)
) -> list[dict]:
    """내 토큰(회수되지 않은 것)만. 원문/해시는 절대 반환하지 않는다."""
    rows = db.scalars(
        select(ApiToken)
        .where(ApiToken.user_id == user.id, ApiToken.revoked_at.is_(None))
        .order_by(ApiToken.created_at.desc())
    ).all()
    return [_token_out(db, t) for t in rows]


@router.delete("/{token_id}")
def revoke(
    token_id: str, user: User = Depends(current_user), db: Session = Depends(get_db)
) -> dict:
    """토큰 회수(본인 것만). 이후 그 토큰의 업로드는 401."""
    token = db.get(ApiToken, token_id)
    if token is None or token.user_id != user.id:
        raise HTTPException(status_code=404, detail="토큰이 없습니다")
    if token.revoked_at is None:
        token.revoked_at = utcnow()
        audit.log(db, "token_revoke", user_id=user.id, detail=token.label or token.id)
    return {"ok": True}
