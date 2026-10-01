from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..deps import Principal, current_principal, get_db
from ..models import Space, Team, TeamMember, User
from ..services import tokens as tokens_svc

router = APIRouter(prefix="/api", tags=["spaces"])


def visible_spaces(db: Session, user: User) -> list[dict]:
    """사용자가 접근 가능한 공간: 개인(본인) + 소속 팀 + 전체."""
    result: list[dict] = []

    personal = db.scalar(select(Space).where(Space.type == "personal", Space.user_id == user.id))
    if personal:
        result.append({"id": personal.id, "type": "personal", "name": "내 공간"})

    team_rows = db.execute(
        select(Space, Team)
        .join(Team, Team.id == Space.team_id)
        .join(TeamMember, TeamMember.team_id == Team.id)
        .where(Space.type == "team", TeamMember.user_id == user.id)
        .order_by(Team.name)
    ).all()
    result.extend(
        {"id": space.id, "type": "team", "name": team.name} for space, team in team_rows
    )

    org = db.scalar(select(Space).where(Space.type == "org"))
    if org:
        result.append({"id": org.id, "type": "org", "name": "전체 공간"})
    return result


@router.get("/spaces")
def list_spaces(
    principal: Principal = Depends(current_principal), db: Session = Depends(get_db)
) -> list[dict]:
    """세션 쿠키 또는 API 토큰(Bearer)으로 공간 목록 — CLI 가 어디에 올릴지 고를 수 있게.

    토큰으로 물으면 **그 토큰이 갇힌 공간 하나만** 돌려준다. 토큰이 못 들어가는 공간을
    목록에만 띄우면, 고르고 나서야 403 을 보게 된다.
    """
    spaces = visible_spaces(db, principal.user)
    if principal.token is None:
        return spaces
    scoped = tokens_svc.scope_space_id(db, principal.token)
    return [s for s in spaces if s["id"] == scoped]
