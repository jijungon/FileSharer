import time
from collections import defaultdict, deque

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..deps import current_user, get_db
from ..models import User
from ..security import verify_password

router = APIRouter(prefix="/api/auth", tags=["auth"])

# 단순 인메모리 rate limit: 이메일당 60초 안에 10회 실패까지
_WINDOW_SEC, _MAX_ATTEMPTS = 60, 10
_attempts: dict[str, deque[float]] = defaultdict(deque)


def _rate_limited(key: str) -> bool:
    now = time.monotonic()
    q = _attempts[key]
    while q and now - q[0] > _WINDOW_SEC:
        q.popleft()
    return len(q) >= _MAX_ATTEMPTS


def _record_failure(key: str) -> None:
    _attempts[key].append(time.monotonic())


class LoginBody(BaseModel):
    email: str
    password: str


@router.post("/login")
def login(body: LoginBody, request: Request, db: Session = Depends(get_db)) -> dict:
    email = body.email.lower().strip()
    if _rate_limited(email):
        raise HTTPException(status_code=429, detail="시도가 너무 많습니다. 잠시 후 다시 시도하세요")

    user = db.scalar(select(User).where(User.email == email))
    ok = (
        user is not None
        and user.is_active
        and user.password_hash != ""
        and verify_password(body.password, user.password_hash)
    )
    if not ok:
        _record_failure(email)
        raise HTTPException(status_code=401, detail="이메일 또는 비밀번호가 올바르지 않습니다.")

    _attempts.pop(email, None)
    request.session["uid"] = user.id
    return {"ok": True}


@router.post("/logout")
def logout(request: Request) -> dict:
    request.session.clear()
    return {"ok": True}


me_router = APIRouter(prefix="/api", tags=["auth"])


@me_router.get("/me")
def me(user: User = Depends(current_user)) -> dict:
    return {"id": user.id, "email": user.email, "name": user.name, "role": user.role}
