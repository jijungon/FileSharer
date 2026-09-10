import os
from collections.abc import Callable

import pytest
from fastapi.testclient import TestClient


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    """로컬 .env의 실제 값이 테스트로 새지 않도록 관련 변수 제거."""
    for key in list(os.environ):
        if key.startswith(("GOOGLE_", "ADMIN_", "SHARE_", "APP_", "SECRET_", "DATA_", "DATABASE_")):
            monkeypatch.delenv(key, raising=False)
    yield


@pytest.fixture()
def app_factory(tmp_path, monkeypatch) -> Callable:
    """임시 DATA_DIR·SQLite로 격리된 앱 생성기. env 오버라이드 가능."""

    def make(**env: str):
        monkeypatch.setenv("APP_ENV", "test")
        monkeypatch.setenv("SECRET_KEY", "test-secret-key")
        monkeypatch.setenv("DATA_DIR", str(tmp_path / "data"))
        monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'test.db'}")
        monkeypatch.setenv("GOOGLE_CLIENT_ID", "")
        monkeypatch.setenv("GOOGLE_CLIENT_SECRET", "")
        for key, value in env.items():
            monkeypatch.setenv(key, value)
        monkeypatch.chdir(tmp_path)

        from app.config import get_settings

        get_settings.cache_clear()
        from app.main import create_app

        return create_app()

    yield make
    from app.config import get_settings

    get_settings.cache_clear()


ADMIN_EMAIL = "admin@test.local"
ADMIN_PASSWORD = "admin-pass-123"


@pytest.fixture()
def client(app_factory) -> TestClient:
    """부트스트랩 관리자(ADMIN_EMAIL/PASSWORD)가 생성된 앱의 클라이언트."""
    app = app_factory(ADMIN_EMAIL=ADMIN_EMAIL, ADMIN_PASSWORD=ADMIN_PASSWORD)
    with TestClient(app) as c:
        yield c


@pytest.fixture()
def db(client):
    SessionLocal = client.app.state.sessionmaker
    session = SessionLocal()
    try:
        yield session
        session.commit()
    finally:
        session.close()


def login(client: TestClient, email: str, password: str):
    return client.post("/api/auth/login", json={"email": email, "password": password})


@pytest.fixture()
def admin_client(client) -> TestClient:
    res = login(client, ADMIN_EMAIL, ADMIN_PASSWORD)
    assert res.status_code == 200
    return client
