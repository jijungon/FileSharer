from collections.abc import Iterator

from fastapi import Depends, HTTPException, Request
from sqlalchemy.orm import Session

from .models import User


def get_db(request: Request) -> Iterator[Session]:
    """요청 세션. 성공 시 커밋은 미들웨어(commit_db_middleware)가 응답 전송 '전에' 수행한다.
    (FastAPI의 yield 의존성 teardown은 응답 전송 '후'에 돌아, 방금 만든 자원을 곧바로
    조회하면 커밋 전이라 404가 나던 read-after-write 경합을 피하기 위함.)
    예외 시에는 여기서 즉시 롤백한다.
    """
    SessionLocal = request.app.state.sessionmaker
    db = SessionLocal()
    request.state.db = db
    try:
        yield db
    except Exception:
        db.rollback()
        raise


def current_user(request: Request, db: Session = Depends(get_db)) -> User:
    uid = request.session.get("uid")
    if not uid:
        raise HTTPException(status_code=401, detail="로그인이 필요합니다.")
    user = db.get(User, uid)
    if user is None or not user.is_active:
        request.session.clear()
        raise HTTPException(status_code=401, detail="로그인이 필요합니다.")
    return user


def require_admin(user: User = Depends(current_user)) -> User:
    if not user.is_admin:
        raise HTTPException(status_code=403, detail="관리자 권한이 필요합니다.")
    return user
