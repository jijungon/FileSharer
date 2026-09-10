import os

import pytest
from fastapi.testclient import TestClient


@pytest.fixture()
def client(tmp_path, monkeypatch) -> TestClient:
    """임시 DATA_DIR·SQLite로 격리된 앱 인스턴스를 만든다 (실제 .env 미사용)."""
    monkeypatch.setenv("APP_ENV", "test")
    monkeypatch.setenv("SECRET_KEY", "test-secret-key")
    monkeypatch.setenv("DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'test.db'}")
    monkeypatch.setenv("GOOGLE_CLIENT_ID", "")
    monkeypatch.setenv("GOOGLE_CLIENT_SECRET", "")
    monkeypatch.chdir(tmp_path)  # .env 파일이 있어도 읽히지 않도록 작업 디렉토리 이동

    from app.config import get_settings

    get_settings.cache_clear()
    from app.main import create_app

    app = create_app()
    with TestClient(app) as c:
        yield c
    get_settings.cache_clear()


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    # 로컬 .env의 실제 값이 테스트로 새지 않도록 관련 변수 제거
    for key in list(os.environ):
        if key.startswith(("GOOGLE_", "ADMIN_", "SHARE_", "APP_", "SECRET_", "DATA_", "DATABASE_")):
            monkeypatch.delenv(key, raising=False)
    yield
