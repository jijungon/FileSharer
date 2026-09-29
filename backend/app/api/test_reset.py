"""테스트 전용 데이터 초기화 — ENABLE_TEST_RESET일 때만 마운트된다(프로덕션엔 라우트 자체가 없음).

e2e가 각 테스트 '전에' 호출해 파일 트리·즐겨찾기·조회기록·편집잠금·API 토큰·공유 링크를 비운다.
사용자·공간(개인/전체)·팀·감사 로그는 보존한다(로그인/구조가 유지되도록). 인증은 요구하지 않으며,
안전은 '플래그가 켜졌고 프로덕션이 아닐 때만 라우트가 존재'하는 것으로 보장한다(main.py 참고).

**범위**가 중요하다. 예전엔 무조건 전부 지웠는데, 그러면 테스트를 병렬로 돌릴 수 없다 —
한 워커의 리셋이 다른 워커가 방금 만든 파일을 지운다. 그래서 `email` 을 주면 **그 사람의
개인 공간만** 비운다. 워커마다 계정이 다르면 서로를 건드리지 않는다.
전부 비우는 건 실행 시작에 딱 한 번만 쓴다(globalSetup).
"""

import logging

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import bindparam, delete, select, text
from sqlalchemy.orm import Session

from ..config import get_settings
from ..deps import get_db
from ..models import ApiToken, EditLock, Favorite, Node, NodeView, ShareLink, Space, User
from ..services.storage import build_storage

logger = logging.getLogger("filesharer")

router = APIRouter(prefix="/api/test", tags=["test"])

# 지울 콘텐츠 테이블(자식→부모 순). 사용자·공간·팀·감사는 건드리지 않는다.
_CONTENT_MODELS = (ShareLink, Favorite, NodeView, EditLock, ApiToken, Node)


@router.post("/reset")
def reset(email: str | None = None, db: Session = Depends(get_db)) -> dict:
    """콘텐츠를 비우고, 그 파일들의 블롭과 검색 인덱스도 함께 정리한다.

    `email` 을 주면 **그 사람의 개인 공간만** 비운다(병렬 실행용 — 워커끼리 안 건드린다).
    안 주면 전부 비운다(실행 시작에 한 번).

    행만 지우면 블롭이 스토리지에 그대로 남는다. 원격 스토리지(R2)를 쓰는 로컬 환경에서
    e2e를 반복 실행하면 참조 없는 고아 오브젝트가 수백 개씩 쌓였다(실제로 992개 누적).
    그래서 행을 지우기 전에 storage_key 를 모아 블롭까지 지운다.
    """
    space_ids: list[str] | None = None
    if email:
        user = db.scalar(select(User).where(User.email == email.lower().strip()))
        if user is None:
            raise HTTPException(status_code=404, detail="그런 사용자가 없습니다")
        space_ids = [
            s.id
            for s in db.scalars(
                select(Space).where(Space.type == "personal", Space.user_id == user.id)
            )
        ]

    def scoped(stmt):
        """space_ids 가 있으면 그 공간의 노드로만 한정한다."""
        if space_ids is None:
            return stmt
        return stmt.where(Node.space_id.in_(space_ids))

    keys = [
        k
        for (k,) in db.execute(
            scoped(
                select(Node.storage_key).where(
                    Node.storage_key.is_not(None), Node.storage_key != ""
                )
            )
        ).all()
        if k
    ]
    storage = build_storage(get_settings())
    purged = 0
    for key in keys:
        try:
            storage.delete(key)
            purged += 1
        except Exception:  # noqa: BLE001 — 이미 없거나 못 지워도 리셋 자체는 계속한다
            logger.debug("테스트 리셋: 블롭 삭제 실패 key=%s", key)

    # 지울 노드 id 를 먼저 확정한다 — 노드를 지운 뒤에는 무엇을 참조했는지 알 수 없다.
    node_ids = [i for (i,) in db.execute(scoped(select(Node.id))).all()]

    # 내용 검색 인덱스(FTS 가상 테이블)는 FK가 없어 따로 비운다. 실패해도 롤백 후 계속할 수
    # 있도록 다른 삭제보다 먼저 한다(마이그레이션 전이면 테이블이 없을 수 있다).
    try:
        if space_ids is None:
            db.execute(text("DELETE FROM node_content_fts"))
        elif node_ids:
            db.execute(
                text("DELETE FROM node_content_fts WHERE node_id IN :ids").bindparams(
                    bindparam("ids", expanding=True)
                ),
                {"ids": node_ids},
            )
    except Exception:  # noqa: BLE001
        db.rollback()
        logger.debug("테스트 리셋: node_content_fts 없음 — 건너뜀")

    for model in _CONTENT_MODELS:
        if space_ids is None:
            db.execute(delete(model))
        elif node_ids:
            column = Node.id if model is Node else model.node_id
            db.execute(delete(model).where(column.in_(node_ids)))
    db.commit()
    scope = f"{email} 의 개인 공간" if email else "전체"
    return {"ok": True, "scope": scope, "nodes_deleted": len(node_ids), "blobs_deleted": purged}
