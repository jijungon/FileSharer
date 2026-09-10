import pytest


def test_health(client):
    res = client.get("/api/health")
    assert res.status_code == 200
    assert res.json()["ok"] is True


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
