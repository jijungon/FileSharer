from authlib.integrations.starlette_client import OAuth, OAuthError
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import RedirectResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..bootstrap import create_user, users_count
from ..config import Settings, get_settings
from ..deps import get_db
from ..models import User

router = APIRouter(prefix="/api/auth", tags=["auth"])

_oauth = OAuth()
_registered = False


def _google_client(settings: Settings):
    global _registered
    if not settings.google_client_id or not settings.google_client_secret:
        raise HTTPException(status_code=503, detail="구글 로그인이 설정되지 않았습니다")
    if not _registered:
        _oauth.register(
            name="google",
            client_id=settings.google_client_id,
            client_secret=settings.google_client_secret,
            server_metadata_url="https://accounts.google.com/.well-known/openid-configuration",
            client_kwargs={"scope": "openid email profile"},
        )
        _registered = True
    return _oauth.google


class DomainNotAllowedError(Exception):
    pass


class AccountDisabledError(Exception):
    pass


def resolve_google_user(db: Session, claims: dict, allowed_domain: str) -> User:
    """OIDC 클레임 → 사용자 매핑. 도메인 검증 + 자동 프로비저닝 + 최초 사용자 admin."""
    email = (claims.get("email") or "").lower().strip()
    domain = email.split("@")[-1] if "@" in email else ""
    hd = claims.get("hd") or ""

    if not allowed_domain or domain != allowed_domain or (hd and hd != allowed_domain):
        raise DomainNotAllowedError(email)

    user = db.scalar(select(User).where(User.email == email))
    if user is None:
        role = "admin" if users_count(db) == 0 else "member"
        user = create_user(db, email=email, name=claims.get("name") or "", role=role)
        db.commit()
    if not user.is_active:
        raise AccountDisabledError(email)
    return user


@router.get("/config")
def auth_config(settings: Settings = Depends(get_settings)) -> dict:
    return {"google_enabled": bool(settings.google_client_id and settings.google_client_secret)}


def _return_origin(request: Request) -> str:
    """로그인을 시작한 오리진 — dev면 vite(5173), prod면 공개 호스트."""
    return str(request.base_url).rstrip("/")


def _redirect_after_login(origin: str, path: str) -> RedirectResponse:
    target = f"{origin}{path}" if origin else path
    return RedirectResponse(target)


@router.get("/google")
async def google_login(request: Request):
    settings = get_settings()
    client = _google_client(settings)
    # 콜백은 백엔드 오리진(8642 등)으로 돌아오므로, 끝나면 시작 오리진으로 복귀시킨다
    request.session["post_login_origin"] = _return_origin(request)
    redirect_uri = settings.base_url.rstrip("/") + "/api/auth/google/callback"
    return await client.authorize_redirect(request, redirect_uri)


@router.get("/google/callback")
async def google_callback(request: Request, db: Session = Depends(get_db)):
    settings = get_settings()
    client = _google_client(settings)
    origin = request.session.pop("post_login_origin", "")
    try:
        token = await client.authorize_access_token(request)
    except OAuthError:
        return _redirect_after_login(origin, "/login?error=oauth_failed")

    claims = token.get("userinfo") or {}
    try:
        user = resolve_google_user(db, dict(claims), settings.allowed_google_domain.lower())
    except DomainNotAllowedError:
        return _redirect_after_login(origin, "/login?error=forbidden_domain")
    except AccountDisabledError:
        return _redirect_after_login(origin, "/login?error=disabled")

    request.session["uid"] = user.id
    return _redirect_after_login(origin, "/files")
