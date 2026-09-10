import pytest

from app.api.google_auth import (
    AccountDisabledError,
    DomainNotAllowedError,
    resolve_google_user,
)
from app.bootstrap import create_user
from app.models import User, utcnow

DOMAIN = "test.local"


def claims(email: str, name: str = "사용자", hd: str | None = DOMAIN) -> dict:
    data = {"email": email, "name": name}
    if hd is not None:
        data["hd"] = hd
    return data


def test_google_login_returns_503_when_not_configured(client):
    res = client.get("/api/auth/google", follow_redirects=False)
    assert res.status_code == 503


def test_auth_config_reports_google_disabled(client):
    assert client.get("/api/auth/config").json() == {"google_enabled": False}


def test_auth_config_reports_google_enabled(app_factory):
    from fastapi.testclient import TestClient

    app = app_factory(GOOGLE_CLIENT_ID="cid", GOOGLE_CLIENT_SECRET="sec")
    with TestClient(app) as c:
        assert c.get("/api/auth/config").json() == {"google_enabled": True}


def test_wrong_domain_rejected(client, db):
    with pytest.raises(DomainNotAllowedError):
        resolve_google_user(db, claims("user@evil.example", hd="evil.example"), DOMAIN)


def test_hd_mismatch_rejected_even_if_email_matches(client, db):
    with pytest.raises(DomainNotAllowedError):
        resolve_google_user(db, claims(f"user@{DOMAIN}", hd="other.example"), DOMAIN)


def test_first_google_user_becomes_admin(app_factory):
    """users가 비어 있으면(로컬 admin 미설정) 첫 구글 로그인 사용자가 admin."""
    from fastapi.testclient import TestClient

    app = app_factory()  # ADMIN_EMAIL 없음 -> users 비어 있음
    with TestClient(app) as c:  # noqa: F841
        SessionLocal = app.state.sessionmaker
        with SessionLocal() as db:
            user = resolve_google_user(db, claims(f"first@{DOMAIN}"), DOMAIN)
            assert user.role == "admin"
            assert user.password_hash == ""  # 로컬 로그인 불가 계정

            second = resolve_google_user(db, claims(f"second@{DOMAIN}"), DOMAIN)
            assert second.role == "member"


def test_existing_user_is_reused(client, db):
    first = resolve_google_user(db, claims(f"repeat@{DOMAIN}"), DOMAIN)
    again = resolve_google_user(db, claims(f"repeat@{DOMAIN}"), DOMAIN)
    assert first.id == again.id


def test_disabled_google_user_rejected(client, db):
    create_user(db, email=f"gone@{DOMAIN}")
    db.commit()
    user = db.query(User).filter_by(email=f"gone@{DOMAIN}").one()
    user.disabled_at = utcnow()
    db.commit()

    with pytest.raises(AccountDisabledError):
        resolve_google_user(db, claims(f"gone@{DOMAIN}"), DOMAIN)


def test_provisioned_user_gets_personal_space(client, db):
    resolve_google_user(db, claims(f"space@{DOMAIN}"), DOMAIN)
    from app.models import Space

    user = db.query(User).filter_by(email=f"space@{DOMAIN}").one()
    assert db.query(Space).filter_by(type="personal", user_id=user.id).count() == 1
