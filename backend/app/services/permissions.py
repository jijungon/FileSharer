"""공간 기반 권한 — 접근 가능 = 조작 가능 (아키텍처 문서의 매트릭스).

personal: 소유자만 (관리자도 열람 불가 — 프라이버시 원칙)
team:     팀원만
org:      로그인 사용자 전원
"""

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import Node, Space, TeamMember, User


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


def has_deleted_ancestor(db: Session, node: Node) -> bool:
    """조상(부모 이상) 중 하나라도 휴지통(deleted_at)에 있으면 True.

    soft_delete는 대상(루트)만 deleted_at을 찍고 자식엔 안 찍는다. 그래서 폴더를
    휴지통에 넣어도 자식은 deleted_at=None으로 남아, 자식 id를 직접 아는 딥링크로는
    여전히 열람·다운로드가 가능했다(프라이버시 유출). 이를 막으려면 노드 접근 시
    조상 사슬에 휴지통 항목이 있는지 확인해야 한다. 자기 자신은 보지 않는다 —
    호출부가 node.deleted_at을 별도로 검사. seen 상한은 손상된 부모 사이클 방어.
    """
    current_id = node.parent_id
    seen = 0
    while current_id is not None and seen < 1000:
        parent = db.get(Node, current_id)
        if parent is None:
            break
        if parent.deleted_at is not None:
            return True
        current_id = parent.parent_id
        seen += 1
    return False


def get_node_checked(
    db: Session, user: User, node_id: str, *, include_deleted: bool = False
) -> Node:
    node = db.get(Node, node_id)
    if node is None:
        raise HTTPException(status_code=404, detail="항목이 없습니다")
    # 자신이 휴지통이거나, 조상 폴더가 휴지통이면 '없는 것'으로 취급(자식 딥링크 차단).
    # include_deleted=True(restore·purge)는 두 검사를 모두 건너뛴다.
    if not include_deleted and (
        node.deleted_at is not None or has_deleted_ancestor(db, node)
    ):
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
