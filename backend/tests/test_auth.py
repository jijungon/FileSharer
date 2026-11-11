from app.bootstrap import create_user
from app.models import User, utcnow
from tests.conftest import ADMIN_EMAIL, ADMIN_PASSWORD, login


def test_bootstrap_admin_login_and_me(client):
    res = login(client, ADMIN_EMAIL, ADMIN_PASSWORD)
    assert res.status_code == 200

    me = client.get("/api/me")
    assert me.status_code == 200
    body = me.json()
    assert body["email"] == ADMIN_EMAIL
    assert body["role"] == "admin"


def test_wrong_password_rejected(client):
    assert login(client, ADMIN_EMAIL, "nope-wrong").status_code == 401


def test_logout_clears_session(admin_client):
    assert admin_client.post("/api/auth/logout").status_code == 200
    assert admin_client.get("/api/me").status_code == 401


def test_me_requires_login(client):
    assert client.get("/api/me").status_code == 401


def test_disabled_user_cannot_login(client, db):
    create_user(db, email="off@test.local", password="pw-123456", name="Off")
    db.commit()
    user = db.query(User).filter_by(email="off@test.local").one()
    user.disabled_at = utcnow()
    db.commit()

    assert login(client, "off@test.local", "pw-123456").status_code == 401


def test_google_only_user_has_no_local_login(client, db):
    create_user(db, email="google@test.local", name="G")  # password 없음
    db.commit()
    assert login(client, "google@test.local", "anything").status_code == 401


def test_login_rate_limited_after_repeated_failures(client):
    email = "burst@test.local"
    for _ in range(10):
        assert login(client, email, "bad").status_code == 401
    assert login(client, email, "bad").status_code == 429


# ---------- 비밀번호(로컬) 로그인은 테스트·개발 전용 ----------


def test_local_login_off_by_default(app_factory):
    """플래그를 안 켜면 비밀번호 로그인은 '없는 주소'고, 비밀번호 관리자도 만들어지지 않는다."""
    from fastapi.testclient import TestClient
    from sqlalchemy import func, select

    app = app_factory(
        ADMIN_EMAIL=ADMIN_EMAIL, ADMIN_PASSWORD=ADMIN_PASSWORD, ENABLE_LOCAL_LOGIN="0"
    )
    with TestClient(app) as c:
        assert login(c, ADMIN_EMAIL, ADMIN_PASSWORD).status_code == 404
        assert c.get("/api/auth/config").json()["local_login_enabled"] is False
        with c.app.state.sessionmaker() as s:
            assert s.scalar(select(func.count()).select_from(User)) == 0


def test_local_login_ignored_in_prod_even_when_flag_set(app_factory):
    """운영에선 켜도 무시한다 — 비밀번호가 맞는 계정이 DB에 남아 있어도 못 들어온다."""
    from fastapi.testclient import TestClient

    app = app_factory(
        APP_ENV="prod", SECRET_KEY="a-real-prod-secret-key-0123456789", ENABLE_LOCAL_LOGIN="1"
    )
    with TestClient(app) as c:
        with c.app.state.sessionmaker() as s:
            create_user(s, email="old-admin@test.local", role="admin", password="old-pass-123")
            s.commit()
        assert login(c, "old-admin@test.local", "old-pass-123").status_code == 404
        assert c.get("/api/auth/config").json()["local_login_enabled"] is False


def test_local_login_enabled_reported_in_config(client):
    assert client.get("/api/auth/config").json()["local_login_enabled"] is True
