from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..bootstrap import create_user
from ..deps import current_user, get_db, require_admin
from ..models import Space, Team, TeamMember, User, utcnow

router = APIRouter(prefix="/api", tags=["admin"])


def _user_out(user: User) -> dict:
    return {
        "id": user.id,
        "email": user.email,
        "name": user.name,
        "role": user.role,
        "disabled": not user.is_active,
        "local_login": user.password_hash != "",
    }


# ---------- 사용자 ----------


class CreateUserBody(BaseModel):
    email: str
    name: str = ""
    password: str | None = None
    role: str = "member"


@router.get("/users")
def list_users(_: User = Depends(require_admin), db: Session = Depends(get_db)) -> list[dict]:
    users = db.scalars(select(User).order_by(User.created_at)).all()
    return [_user_out(u) for u in users]


@router.post("/users", status_code=201)
def invite_user(
    body: CreateUserBody, _: User = Depends(require_admin), db: Session = Depends(get_db)
) -> dict:
    email = body.email.lower().strip()
    if not email or "@" not in email:
        raise HTTPException(status_code=422, detail="올바른 이메일이 아닙니다")
    if body.role not in ("admin", "member"):
        raise HTTPException(status_code=422, detail="role은 admin 또는 member")
    if db.scalar(select(User).where(User.email == email)):
        raise HTTPException(status_code=409, detail="이미 존재하는 이메일입니다")
    user = create_user(db, email=email, name=body.name, role=body.role, password=body.password)
    return _user_out(user)


class PatchUserBody(BaseModel):
    role: str | None = None
    disabled: bool | None = None


@router.patch("/users/{user_id}")
def patch_user(
    user_id: str,
    body: PatchUserBody,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> dict:
    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=404, detail="사용자가 없습니다")

    if body.role is not None:
        if body.role not in ("admin", "member"):
            raise HTTPException(status_code=422, detail="role은 admin 또는 member")
        if user.id == admin.id and body.role != "admin":
            raise HTTPException(status_code=400, detail="본인의 관리자 권한은 해제할 수 없습니다")
        user.role = body.role

    if body.disabled is not None:
        if user.id == admin.id and body.disabled:
            raise HTTPException(status_code=400, detail="본인 계정은 비활성화할 수 없습니다")
        user.disabled_at = utcnow() if body.disabled else None

    return _user_out(user)


# ---------- 팀 ----------


class CreateTeamBody(BaseModel):
    name: str


def _team_out(db: Session, team: Team) -> dict:
    members = db.execute(
        select(User)
        .join(TeamMember, TeamMember.user_id == User.id)
        .where(TeamMember.team_id == team.id)
        .order_by(User.email)
    ).scalars()
    return {
        "id": team.id,
        "name": team.name,
        "members": [{"id": u.id, "email": u.email, "name": u.name} for u in members],
    }


@router.get("/teams")
def list_teams(_: User = Depends(require_admin), db: Session = Depends(get_db)) -> list[dict]:
    teams = db.scalars(select(Team).order_by(Team.name)).all()
    return [_team_out(db, t) for t in teams]


@router.post("/teams", status_code=201)
def create_team(
    body: CreateTeamBody, _: User = Depends(require_admin), db: Session = Depends(get_db)
) -> dict:
    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=422, detail="팀 이름이 비어 있습니다")
    if db.scalar(select(Team).where(Team.name == name)):
        raise HTTPException(status_code=409, detail="이미 존재하는 팀 이름입니다")
    team = Team(name=name)
    db.add(team)
    db.flush()
    db.add(Space(type="team", team_id=team.id))  # 팀 공간 자동 생성
    return _team_out(db, team)


class AddMemberBody(BaseModel):
    user_id: str


@router.post("/teams/{team_id}/members", status_code=201)
def add_member(
    team_id: str,
    body: AddMemberBody,
    _: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> dict:
    team = db.get(Team, team_id)
    if team is None:
        raise HTTPException(status_code=404, detail="팀이 없습니다")
    if db.get(User, body.user_id) is None:
        raise HTTPException(status_code=404, detail="사용자가 없습니다")
    exists = db.scalar(
        select(TeamMember).where(
            TeamMember.team_id == team_id, TeamMember.user_id == body.user_id
        )
    )
    if exists:
        raise HTTPException(status_code=409, detail="이미 팀원입니다")
    db.add(TeamMember(team_id=team_id, user_id=body.user_id))
    db.flush()
    return _team_out(db, team)


@router.delete("/teams/{team_id}/members/{user_id}")
def remove_member(
    team_id: str,
    user_id: str,
    _: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> dict:
    membership = db.scalar(
        select(TeamMember).where(TeamMember.team_id == team_id, TeamMember.user_id == user_id)
    )
    if membership is None:
        raise HTTPException(status_code=404, detail="팀원이 아닙니다")
    db.delete(membership)
    team = db.get(Team, team_id)
    db.flush()
    return _team_out(db, team)


# ---------- 팀원 열람 (일반 사용자: 소속 팀만) ----------


@router.get("/teams/{team_id}/members")
def view_members(
    team_id: str, user: User = Depends(current_user), db: Session = Depends(get_db)
) -> list[dict]:
    team = db.get(Team, team_id)
    if team is None:
        raise HTTPException(status_code=404, detail="팀이 없습니다")
    is_member = db.scalar(
        select(TeamMember).where(TeamMember.team_id == team_id, TeamMember.user_id == user.id)
    )
    if not (user.is_admin or is_member):
        raise HTTPException(status_code=403, detail="팀원만 볼 수 있습니다")
    return _team_out(db, team)["members"]
