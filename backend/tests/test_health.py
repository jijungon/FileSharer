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


# ── SPA 껍데기 캐시 (프로덕션에서 '배포했는데 옛 화면' 을 만들던 자리) ──────────


def test_spa_shell_must_be_revalidated(app_factory, tmp_path, monkeypatch):
    """index.html 에 Cache-Control 이 없으면 브라우저가 **휴리스틱 캐싱**을 쓴다.

    대략 (지금 - Last-Modified) × 10% 를 유효기간으로 잡는데, 마지막 배포로부터
    시간이 흐를수록 그 창이 커진다 — 3일 전 배포 상태로 들어온 사람에겐 7시간쯤
    유효한 걸로 읽힌다. 그러면 오늘 배포해도 그 사람은 몇 시간 옛 화면을 본다.

    실제로 겪었다(v1.0.7 확인 때 "아직 옛 화면" 이 나왔다). 배포 반영을 확인할 유일한
    수단이 화면이라 가볍지 않다.

    **가짜 static 을 깔고 앱을 띄우는 이유**: backend/static 은 프런트를 빌드해야
    생기고 gitignore 대상이라 CI 엔 없다. 진짜 빌드에 기대면 이 테스트는 CI 에서
    조용히 건너뛰어 아무것도 지키지 못한다.
    """
    from fastapi.testclient import TestClient

    import app.main as main

    static = tmp_path / "fake-static"
    (static / "assets").mkdir(parents=True)
    (static / "index.html").write_text("<!doctype html><title>x</title>", encoding="utf-8")
    (static / "favicon.ico").write_bytes(b"\x00")
    monkeypatch.setattr(main, "STATIC_DIR", static)

    with TestClient(app_factory()) as client:
        for path in ("/", "/files", "/favicon.ico"):
            res = client.get(path)
            assert res.status_code == 200, f"{path}: {res.status_code}"
            assert res.headers.get("cache-control") == "no-cache", path
            # 재검증할 근거(검증자)는 있어야 한다. 지금 starlette 는 조건부 요청에
            # 304 를 안 돌려주지만(전부 다시 보낸다), 앞단이나 라이브러리가 나중에
            # 처리하게 되면 그때 공짜로 효과를 본다.
            assert res.headers.get("last-modified") or res.headers.get("etag"), path
