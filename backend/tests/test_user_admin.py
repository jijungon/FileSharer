"""계정 비상 도구 — 막다른 길(관리자 잠김)에서 실제로 빠져나오는지.

이 스크립트는 **다른 모든 방법이 막혔을 때** 꺼내는 물건이다. 그때 동작하지 않으면
아무 소용이 없으므로, 실제 프로세스로 실행해 확인한다.
"""

import os
import subprocess
import sys
from pathlib import Path

import pytest

from app.bootstrap import create_user
from app.db import build_engine, make_sessionmaker, run_migrations

SCRIPT = Path(__file__).resolve().parent.parent / "scripts" / "user_admin.py"


@pytest.fixture()
def cli(tmp_path):
    """마이그레이션된 임시 DB + 부트스트랩 관리자 + 일반 사용자 하나."""
    db_url = f"sqlite:///{tmp_path / 'app.db'}"
    env = {
        **os.environ,
        "FILESHARER_ENV_FILE": str(tmp_path / "none.env"),
        "DATABASE_URL": db_url,
        "DATA_DIR": str(tmp_path / "data"),
        "STORAGE_BACKEND": "local",
        "ADMIN_EMAIL": "boss@test.local",
        "ADMIN_PASSWORD": "boss-pass-123",
        "SECRET_KEY": "test-key",
        "APP_ENV": "test",
    }
    for key in ("R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"):
        env.pop(key, None)

    # run_bootstrap 은 get_settings() 를 거쳐 **루트 .env 의 실제 ADMIN_EMAIL** 을 읽는다.
    # 테스트에 운영 설정이 새면 안 되므로 계정을 직접 만든다.
    run_migrations(db_url)
    SessionLocal = make_sessionmaker(build_engine(db_url))
    with SessionLocal() as db:
        create_user(db, email="boss@test.local", role="admin", password="boss-pass-123")
        create_user(db, email="member@test.local", role="member")
        db.commit()

    def run(*args: str) -> subprocess.CompletedProcess:
        return subprocess.run(
            [sys.executable, str(SCRIPT), *args],
            env=env,
            capture_output=True,
            text=True,
            timeout=60,
        )

    return run


def test_list_shows_roles_and_admin_count(cli):
    res = cli("list")
    assert res.returncode == 0, res.stderr
    assert "boss@test.local" in res.stdout
    assert "member@test.local" in res.stdout
    assert "활성 관리자 1명" in res.stdout


def test_promote_then_demote(cli):
    assert cli("promote", "member@test.local").returncode == 0
    assert "활성 관리자 2명" in cli("list").stdout

    assert cli("demote", "member@test.local").returncode == 0
    assert "활성 관리자 1명" in cli("list").stdout


def test_promote_is_idempotent(cli):
    res = cli("promote", "boss@test.local")
    assert res.returncode == 0
    assert "이미 관리자" in res.stdout


def test_cannot_demote_last_admin(cli):
    """마지막 관리자를 내리면 이 스크립트 말고는 아무도 되돌릴 수 없다."""
    res = cli("demote", "boss@test.local")
    assert res.returncode == 1
    assert "마지막 관리자" in res.stdout
    assert "활성 관리자 1명" in cli("list").stdout  # 그대로 남아 있어야 한다


def test_unknown_email_fails_clearly(cli):
    res = cli("promote", "nobody@test.local")
    assert res.returncode == 1
    assert "그런 계정이 없습니다" in res.stdout


def test_email_is_case_insensitive(cli):
    assert cli("promote", "  Member@Test.Local  ").returncode == 0
    assert "활성 관리자 2명" in cli("list").stdout


def test_unmigrated_db_gives_a_readable_error(tmp_path):
    """급할 때 트레이스백을 토하면 더 당황한다."""
    env = {
        **os.environ,
        "FILESHARER_ENV_FILE": str(tmp_path / "none.env"),
        "DATABASE_URL": f"sqlite:///{tmp_path / 'empty.db'}",
        "DATA_DIR": str(tmp_path / "data"),
        "STORAGE_BACKEND": "local",
        "SECRET_KEY": "test-key",
        "APP_ENV": "test",
    }
    res = subprocess.run(
        [sys.executable, str(SCRIPT), "list"], env=env, capture_output=True, text=True, timeout=60
    )
    assert res.returncode == 1
    assert "DB를 읽을 수 없습니다" in res.stdout
    assert "Traceback" not in res.stderr
