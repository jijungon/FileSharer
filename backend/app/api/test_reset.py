"""테스트 전용 데이터 초기화 — ENABLE_TEST_RESET일 때만 마운트된다(프로덕션엔 라우트 자체가 없음).

e2e가 각 테스트 '전에' 호출해 파일 트리·즐겨찾기·조회기록·편집잠금·API 토큰·공유 링크를 비운다.
사용자·공간(개인/전체)·팀·감사 로그는 보존한다(로그인/구조가 유지되도록). 인증은 요구하지 않으며,
안전은 '플래그가 켜졌고 프로덕션이 아닐 때만 라우트가 존재'하는 것으로 보장한다(main.py 참고).
"""

from fastapi import APIRouter, Depends
from sqlalchemy import delete
from sqlalchemy.orm import Session

from ..deps import get_db
from ..models import ApiToken, EditLock, Favorite, Node, NodeView, ShareLink

router = APIRouter(prefix="/api/test", tags=["test"])

# 지울 콘텐츠 테이블(자식→부모 순). 사용자·공간·팀·감사는 건드리지 않는다.
_CONTENT_MODELS = (ShareLink, Favorite, NodeView, EditLock, ApiToken, Node)


@router.post("/reset")
def reset(db: Session = Depends(get_db)) -> dict:
    """콘텐츠 테이블만 비운다(테스트 격리용). 사용자·공간·팀·감사 로그는 유지."""
    for model in _CONTENT_MODELS:
        db.execute(delete(model))
    db.commit()
    return {"ok": True}
