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
