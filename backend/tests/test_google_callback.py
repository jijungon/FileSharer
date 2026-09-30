"""구글 OAuth 콜백 **엔드포인트** 검증 — 조각이 아니라 배선.

`test_google_auth.py` 는 조각을 본다: `resolve_google_user`(도메인·비활성·프로비저닝),
`_redirect_after_login`, `_return_origin`. 전부 통과해도 **콜백이 그것들을 잘못 엮으면**
아무도 모른다. `except AccountDisabledError` 한 줄을 지워도, 성공 경로에서
`request.session["uid"]` 를 빼먹어도 기존 테스트는 전부 초록이다.

그래서 여기서는 콜백을 실제로 호출한다. 구글에는 나가지 않는다 — `_google_client` 를
바꿔치기해 토큰 교환 결과만 흉내 낸다.
"""

import pytest
from authlib.integrations.starlette_client import OAuthError
from fastapi.testclient import TestClient

from app.api import google_auth
from app.bootstrap import create_user
from app.models import User, utcnow

DOMAIN = "test.local"
CALLBACK = "/api/auth/google/callback"


class FakeOAuthClient:
    """authlib 클라이언트 대역. 토큰 교환 결과만 흉내 낸다."""

    def __init__(self, *, claims: dict | None = None, error: Exception | None = None):
        self._claims = claims
        self._error = error

    async def authorize_access_token(self, _request):
        if self._error:
            raise self._error
        return {"userinfo": self._claims}


@pytest.fixture()
def google_app(app_factory, monkeypatch):
    """구글 로그인이 켜진 앱 + 콜백이 쓸 클라이언트를 갈아끼우는 손잡이."""
    app = app_factory(
        GOOGLE_CLIENT_ID="cid",
        GOOGLE_CLIENT_SECRET="sec",
        ALLOWED_GOOGLE_DOMAIN=DOMAIN,
    )

    def use(**kwargs):
        monkeypatch.setattr(google_auth, "_google_client", lambda _s: FakeOAuthClient(**kwargs))
        return app

    return use


def _location(res) -> str:
    return res.headers["location"]


# ── 성공 ───────────────────────────────────────────────────────────────────
def test_callback_signs_the_user_in(google_app):
    """성공하면 /files 로 보내고 **세션이 실제로 선다**.

    리다이렉트만 맞고 로그인이 안 되면 화면은 /files 와 /login 을 오가며 무한 루프에 빠진다.
    """
    app = google_app(claims={"email": f"new@{DOMAIN}", "name": "새 사용자", "hd": DOMAIN})
    with TestClient(app) as c:
        res = c.get(CALLBACK, follow_redirects=False)
        assert res.status_code in (302, 307)
        assert _location(res).endswith("/files")

        # 쿠키가 실제로 권한을 준다 — 이게 콜백이 하는 일의 전부다
        me = c.get("/api/me")
        assert me.status_code == 200
        assert me.json()["email"] == f"new@{DOMAIN}"


def test_callback_provisions_the_account(google_app):
    """처음 온 사람은 그 자리에서 계정이 생긴다(관리자가 미리 만들어둘 필요 없음)."""
    app = google_app(claims={"email": f"fresh@{DOMAIN}", "name": "처음", "hd": DOMAIN})
    with TestClient(app) as c:
        c.get(CALLBACK, follow_redirects=False)
        with app.state.sessionmaker() as db:
            user = db.query(User).filter_by(email=f"fresh@{DOMAIN}").one()
            assert user.password_hash == ""  # 구글 전용 계정 — 비밀번호 로그인 불가


# ── 실패 세 갈래 ───────────────────────────────────────────────────────────
def test_callback_redirects_on_oauth_error(google_app):
    """토큰 교환이 깨지면 500 이 아니라 로그인 화면으로 사유와 함께 돌려보낸다."""
    app = google_app(error=OAuthError("access_denied"))
    with TestClient(app) as c:
        res = c.get(CALLBACK, follow_redirects=False)
        assert _location(res).endswith("/login?error=oauth_failed")
        assert c.get("/api/me").status_code == 401  # 세션이 서면 안 된다


def test_callback_rejects_outside_domain(google_app):
    """사내 도메인 밖은 막는다 — 이게 뚫리면 구글 계정 있는 사람 누구나 들어온다."""
    app = google_app(claims={"email": "outsider@evil.example", "hd": "evil.example"})
    with TestClient(app) as c:
        res = c.get(CALLBACK, follow_redirects=False)
        assert _location(res).endswith("/login?error=forbidden_domain")
        assert c.get("/api/me").status_code == 401

        with app.state.sessionmaker() as db:
            assert db.query(User).filter_by(email="outsider@evil.example").count() == 0


def test_callback_rejects_disabled_account(google_app):
    """비활성 계정은 구글 로그인으로 우회할 수 없어야 한다(퇴사자 차단이 여기 걸려 있다)."""
    app = google_app(claims={"email": f"gone@{DOMAIN}", "hd": DOMAIN})
    with TestClient(app) as c:
        with app.state.sessionmaker() as db:
            create_user(db, email=f"gone@{DOMAIN}")
            db.commit()
            user = db.query(User).filter_by(email=f"gone@{DOMAIN}").one()
            user.disabled_at = utcnow()
            db.commit()

        res = c.get(CALLBACK, follow_redirects=False)
        assert _location(res).endswith("/login?error=disabled")
        assert c.get("/api/me").status_code == 401


# ── 돌아갈 곳 ──────────────────────────────────────────────────────────────
def test_callback_returns_to_frontend_origin(app_factory, monkeypatch):
    """FRONTEND_URL 이 있으면 그 오리진으로 돌려보낸다(dev 의 5173 — 안 그러면 8642 에 갇힌다)."""
    app = app_factory(
        GOOGLE_CLIENT_ID="cid",
        GOOGLE_CLIENT_SECRET="sec",
        ALLOWED_GOOGLE_DOMAIN=DOMAIN,
        FRONTEND_URL="http://localhost:5173",
    )
    monkeypatch.setattr(
        google_auth,
        "_google_client",
        lambda _s: FakeOAuthClient(claims={"email": f"dev@{DOMAIN}", "hd": DOMAIN}),
    )
    with TestClient(app) as c:
        res = c.get(CALLBACK, follow_redirects=False)
        assert _location(res) == "http://localhost:5173/files"


def test_callback_error_also_returns_to_frontend_origin(app_factory, monkeypatch):
    """실패 경로도 같은 오리진으로 — 여기만 빠뜨리면 에러 때 엉뚱한 주소에 떨어진다."""
    app = app_factory(
        GOOGLE_CLIENT_ID="cid",
        GOOGLE_CLIENT_SECRET="sec",
        ALLOWED_GOOGLE_DOMAIN=DOMAIN,
        FRONTEND_URL="http://localhost:5173",
    )
    monkeypatch.setattr(
        google_auth, "_google_client", lambda _s: FakeOAuthClient(error=OAuthError("nope"))
    )
    with TestClient(app) as c:
        res = c.get(CALLBACK, follow_redirects=False)
        assert _location(res) == "http://localhost:5173/login?error=oauth_failed"


# ── 설정 안 됐을 때 ────────────────────────────────────────────────────────
def test_callback_is_503_when_google_not_configured(client):
    """자격증명이 없으면 콜백도 503 — 조용히 통과시키면 안 된다."""
    assert client.get(CALLBACK, follow_redirects=False).status_code == 503
