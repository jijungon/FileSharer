"""공간 기반 권한 — 접근 가능 = 조작 가능 (아키텍처 문서의 매트릭스).

personal: 소유자만 (관리자도 열람 불가 — 프라이버시 원칙)
team:     팀원만
org:      로그인 사용자 전원
"""

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import Node, Space, Team, TeamMember, User


def can_access_space(db: Session, user: User, space: Space) -> bool:
    if space.type == "org":
        return True
    if space.type == "personal":
        return space.user_id == user.id
    if space.type == "team":
        return (
            db.scalar(
                select(TeamMember).where(
                    TeamMember.team_id == space.team_id, TeamMember.user_id == user.id
                )
            )
            is not None
        )
    return False


def get_space_checked(db: Session, user: User, space_id: str) -> Space:
    space = db.get(Space, space_id)
    if space is None:
        raise HTTPException(status_code=404, detail="공간이 없습니다")
    if not can_access_space(db, user, space):
        raise HTTPException(status_code=403, detail="이 공간에 대한 권한이 없습니다")
    return space


def get_node_checked(
    db: Session, user: User, node_id: str, *, include_deleted: bool = False
) -> Node:
    node = db.get(Node, node_id)
    if node is None or (node.deleted_at is not None and not include_deleted):
        raise HTTPException(status_code=404, detail="항목이 없습니다")
    get_space_checked(db, user, node.space_id)
    return node


def is_descendant(db: Session, node_id: str, maybe_ancestor_id: str) -> bool:
    """node가 maybe_ancestor의 자손(또는 자신)인지 — 폴더를 자기 하위로 이동 방지."""
    current: str | None = node_id
    seen = 0
    while current is not None and seen < 1000:
        if current == maybe_ancestor_id:
            return True
        node = db.get(Node, current)
        current = node.parent_id if node else None
        seen += 1
    return False


def space_display_name(db: Session, space: Space) -> str:
    """공간 하나의 표시 이름 — 개인은 '내 공간', 팀은 팀 이름, 전체는 '전체 공간'.

    목록 API(`visible_spaces`)는 팀을 조인해 한 번에 만들고, 여기는 **공간 하나**를
    이름으로 바꿀 때 쓴다(백업 파일명 등). 규칙은 같아야 한다.
    """
    if space.type == "personal":
        return "내 공간"
    if space.type == "org":
        return "전체 공간"
    team = db.get(Team, space.team_id) if space.team_id else None
    return team.name if team else "팀 공간"
