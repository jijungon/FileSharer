import pytest
from fastapi.testclient import TestClient


def test_health(client):
    res = client.get("/api/health")
    assert res.status_code == 200
    assert res.json()["ok"] is True


# 일부러 DSN 모양을 흉내 내지 않는다 — 진짜처럼 생긴 문자열은 비밀 스캐너가 잡고(CI가
# 실제로 잡은 적이 있다), 이 검증엔 '두 값이 구분되는 것'만 있으면 충분하다.
SERVER_DSN = "서버쪽-값-테스트용"
BROWSER_DSN = "브라우저쪽-값-테스트용"


def test_health_never_leaks_the_server_dsn(app_factory):
    """/api/health 엔 인증이 없다 — 서버 DSN이 실리면 아무나 가져간다.

    가져간 사람은 그 프로젝트에 가짜 이벤트를 밀어넣어 무료 한도를 태울 수 있고,
    그때부터 **진짜 에러가 버려진다.** 에러 추적을 붙인 이유가 사라진다.
    """
    app = app_factory(SENTRY_DSN=SERVER_DSN, SENTRY_DSN_FRONTEND=BROWSER_DSN)
    with TestClient(app) as c:
        body = c.get("/api/health").json()

    assert SERVER_DSN not in repr(body)
    assert body["sentry_dsn"] == BROWSER_DSN  # 브라우저용은 내려가야 화면에서 켜진다


def test_health_sends_nothing_when_only_the_server_dsn_is_set(app_factory):
    """서버만 켠 흔한 경우 — 화면엔 아무것도 안 내려가야 한다."""
    app = app_factory(SENTRY_DSN=SERVER_DSN)
    with TestClient(app) as c:
        body = c.get("/api/health").json()

    assert SERVER_DSN not in repr(body)
    assert body["sentry_dsn"] == ""


def test_prod_fails_fast_on_placeholder_secret(monkeypatch, tmp_path):
    monkeypatch.setenv("APP_ENV", "prod")
    monkeypatch.setenv("SECRET_KEY", "dev-only-not-for-prod")
    monkeypatch.setenv("DATA_DIR", str(tmp_path / "data"))
    monkeypatch.chdir(tmp_path)

    from app.config import get_settings

    get_settings.cache_clear()
    from app.main import create_app

    with pytest.raises(RuntimeError, match="SECRET_KEY"):
        create_app()
    get_settings.cache_clear()


def test_root_env_file_is_read_regardless_of_cwd(tmp_path, monkeypatch):
    """루트 .env가 cwd와 무관하게 로드된다 (FILESHARER_ENV_FILE로 주입 검증)."""
    env_file = tmp_path / "custom.env"
    env_file.write_text("MAX_UPLOAD_MB=77\n")
    monkeypatch.setenv("FILESHARER_ENV_FILE", str(env_file))
    monkeypatch.chdir(tmp_path / ".")

    from app.config import get_settings

    get_settings.cache_clear()
    assert get_settings().max_upload_mb == 77
    get_settings.cache_clear()
