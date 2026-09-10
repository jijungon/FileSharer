from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..deps import current_user, get_db
from ..models import Space, Team, TeamMember, User

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
    user: User = Depends(current_user), db: Session = Depends(get_db)
) -> list[dict]:
    return visible_spaces(db, user)
