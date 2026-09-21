from collections.abc import Iterator
from dataclasses import dataclass

from fastapi import Depends, HTTPException, Request
from sqlalchemy.orm import Session

from .models import ApiToken, User, utcnow


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


def _user_from_session(request: Request, db: Session) -> User:
    uid = request.session.get("uid")
    if not uid:
        raise HTTPException(status_code=401, detail="로그인이 필요합니다.")
    user = db.get(User, uid)
    if user is None or not user.is_active:
        request.session.clear()
        raise HTTPException(status_code=401, detail="로그인이 필요합니다.")
    return user


def current_user(request: Request, db: Session = Depends(get_db)) -> User:
    return _user_from_session(request, db)


def require_admin(user: User = Depends(current_user)) -> User:
    if not user.is_admin:
        raise HTTPException(status_code=403, detail="관리자 권한이 필요합니다.")
    return user


@dataclass
class Principal:
    """요청 주체 — 세션 쿠키(token=None) 또는 API 토큰(Bearer)."""

    user: User
    token: ApiToken | None = None


def current_principal(request: Request, db: Session = Depends(get_db)) -> Principal:
    """세션 쿠키 '또는' ``Authorization: Bearer <token>`` 로 주체를 해석한다.
    토큰이면 소유 사용자로 귀속하고 last_used_at을 갱신한다(성공 응답에서만 커밋됨).
    업로드 엔드포인트가 헤드리스 서버 푸시를 받도록 이 의존성을 쓴다."""
    auth = request.headers.get("Authorization", "")
    if auth.startswith("Bearer "):
        # 지연 임포트로 순환 임포트 방지(services.tokens → permissions/security만 의존).
        from .services.tokens import resolve_token

        token = resolve_token(db, auth[len("Bearer "):].strip())
        user = db.get(User, token.user_id)
        if user is None or not user.is_active:
            raise HTTPException(status_code=401, detail="유효하지 않은 토큰입니다")
        token.last_used_at = utcnow()
        return Principal(user=user, token=token)
    return Principal(user=_user_from_session(request, db), token=None)
