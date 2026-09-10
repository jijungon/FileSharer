from collections.abc import Iterator

from fastapi import Depends, HTTPException, Request
from sqlalchemy.orm import Session

from .models import User


def get_db(request: Request) -> Iterator[Session]:
    SessionLocal = request.app.state.sessionmaker
    db = SessionLocal()
    try:
        yield db
        db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


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
