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
