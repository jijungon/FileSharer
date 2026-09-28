"""주기 백업 — 회차 식별·내용물·보관 정책·안전장치."""

import gzip
import io
import json
import logging
import sqlite3
import tarfile
from datetime import UTC, datetime
from pathlib import Path

import pytest

from app.config import get_settings
from app.services import backup
from app.services.backup import LocalBackupStore, prune, run_backup, run_due, stamp_for
from app.services.storage import build_storage
from tests.conftest import ADMIN_EMAIL, ADMIN_PASSWORD, login


def _upload(client, name: str, body: bytes, space_id: str) -> dict:
    res = client.post(
        f"/api/spaces/{space_id}/files",
        files={"file": (name, body, "text/markdown")},
    )
    assert res.status_code == 201, res.text
    return res.json()


@pytest.fixture()
def backup_env(admin_client, tmp_path):
    """업로드가 하나 들어 있는 상태 + 백업 저장소."""
    spaces = admin_client.get("/api/spaces").json()
    personal = next(s for s in spaces if s["type"] == "personal")
    _upload(admin_client, "메모.md", "# 한글 메모\n".encode(), personal["id"])

    settings = get_settings()
    store = LocalBackupStore(tmp_path / "backups")
    SessionLocal = admin_client.app.state.sessionmaker
    return admin_client, settings, store, SessionLocal


def test_stamp_for_sorts_by_time():
    # 문자열 정렬 = 시간 순서여야 보관 정책(오래된 것부터 삭제)이 성립한다
    assert stamp_for("weekly", datetime(2026, 1, 5, tzinfo=UTC)) == "2026-W02"
    assert stamp_for("monthly", datetime(2026, 9, 28, tzinfo=UTC)) == "2026-09"
    stamps = [
        stamp_for("weekly", datetime(2025, 12, 29, tzinfo=UTC)),
        stamp_for("weekly", datetime(2026, 1, 5, tzinfo=UTC)),
    ]
    assert stamps == sorted(stamps)


def test_run_backup_writes_tar_db_and_manifest(backup_env):
    client, settings, store, SessionLocal = backup_env
    with SessionLocal() as db:
        manifest = run_backup(
            db, build_storage(settings), store, "weekly", settings=settings
        )

    assert manifest is not None
    assert manifest["total_files"] >= 1
    # 공간마다 tar 하나 + DB 스냅샷 + manifest
    assert all(item["key"].endswith(".tar.gz") for item in manifest["spaces"])
    assert manifest["db"] is not None and manifest["db"]["bytes"] > 0

    base = f"weekly/{manifest['stamp']}"
    assert store.exists(f"{base}/manifest.json")
    saved = json.loads(store.read_bytes(f"{base}/manifest.json"))
    assert saved["stamp"] == manifest["stamp"]

    # tar 안에 실제 파일이 이름 그대로 들어 있어야 한다(DB 없이도 사람이 복구 가능)
    personal = next(i for i in manifest["spaces"] if i["type"] == "personal")
    raw = store.read_bytes(personal["key"])
    with tarfile.open(fileobj=io.BytesIO(raw), mode="r:gz") as tar:
        names = tar.getnames()
    assert any(n.endswith("메모.md") for n in names)
    # 개인 공간은 소유자 닉네임이 붙어야 사람마다 파일이 안 겹친다
    assert personal["space"].startswith("개인-")


def test_db_snapshot_is_a_readable_database(backup_env):
    client, settings, store, SessionLocal = backup_env
    with SessionLocal() as db:
        manifest = run_backup(
            db, build_storage(settings), store, "weekly", settings=settings
        )

    blob = store.read_bytes(manifest["db"]["key"])
    out = Path(store.root) / "restored.db"
    out.write_bytes(gzip.decompress(blob))
    con = sqlite3.connect(out)
    try:
        # 스냅샷만으로 사용자·노드를 읽을 수 있어야 한다
        assert con.execute("select count(*) from users").fetchone()[0] >= 1
        assert con.execute("select count(*) from nodes").fetchone()[0] >= 1
    finally:
        con.close()


def test_same_period_runs_once(backup_env):
    """배포마다 컨테이너가 재시작돼도 같은 회차를 두 번 찍으면 안 된다."""
    client, settings, store, SessionLocal = backup_env
    with SessionLocal() as db:
        first = run_backup(db, build_storage(settings), store, "weekly", settings=settings)
        second = run_backup(db, build_storage(settings), store, "weekly", settings=settings)
    assert first is not None
    assert second is None


def test_run_due_makes_both_kinds(backup_env):
    client, settings, store, SessionLocal = backup_env
    with SessionLocal() as db:
        lines = run_due(db, build_storage(settings), store, settings)
        again = run_due(db, build_storage(settings), store, settings)
    assert len(lines) == 2  # weekly + monthly
    assert again == []  # 같은 주·같은 달이면 더 할 일이 없다


def test_prune_keeps_newest(tmp_path):
    store = LocalBackupStore(tmp_path / "b")
    for stamp in ("2026-W01", "2026-W02", "2026-W03", "2026-W04"):
        store.put_bytes(f"weekly/{stamp}/manifest.json", b"{}")

    dropped = prune(store, "weekly", keep=2)

    assert dropped == ["2026-W01", "2026-W02"]
    assert store.list_stamps("weekly") == ["2026-W03", "2026-W04"]


def test_prune_keeps_everything_when_under_limit(tmp_path):
    store = LocalBackupStore(tmp_path / "b")
    store.put_bytes("monthly/2026-09/manifest.json", b"{}")
    assert prune(store, "monthly", keep=12) == []
    assert store.list_stamps("monthly") == ["2026-09"]


@pytest.mark.parametrize("stamp", ["", "..", "2026", "../prod", "2026-W1"])
def test_delete_stamp_refuses_bad_names(tmp_path, stamp):
    """삭제가 '회차 하나'가 아닌 경로를 훑으면 백업 전체가 날아간다."""
    store = LocalBackupStore(tmp_path / "b")
    with pytest.raises(ValueError):
        store.delete_stamp("weekly", stamp)


def test_delete_stamp_refuses_unknown_kind(tmp_path):
    store = LocalBackupStore(tmp_path / "b")
    with pytest.raises(ValueError):
        store.delete_stamp("../../prod", "2026-W01")


def test_safe_name_strips_path_separators():
    assert "/" not in backup.safe_name("팀/이름")
    assert backup.safe_name("  ") == "unnamed"


def test_backup_store_choice_follows_settings(tmp_path, monkeypatch):
    """로컬 스토리지면 data_dir 아래, R2면 backup/ 프리픽스를 본다(운영 키와 분리)."""

    class FakeSettings:
        storage_backend = "local"
        data_dir = str(tmp_path)
        backup_prefix = "backup/"

    store = backup.build_backup_store(FakeSettings())
    assert isinstance(store, LocalBackupStore)
    assert store.root == Path(tmp_path) / "backups"


def test_login_still_works_after_backup(backup_env):
    """백업이 DB를 VACUUM INTO 로 떠도 원본은 멀쩡해야 한다."""
    client, settings, store, SessionLocal = backup_env
    with SessionLocal() as db:
        run_backup(db, build_storage(settings), store, "weekly", settings=settings)
    assert login(client, ADMIN_EMAIL, ADMIN_PASSWORD).status_code == 200


def test_migrations_do_not_disable_loggers(tmp_path):
    """백업이 돌았는지는 로그로 확인한다 — 그 로그가 살아 있어야 한다.

    alembic env.py 의 fileConfig 는 기본값이 disable_existing_loggers=True 라,
    기동 시 in-process 마이그레이션이 uvicorn·앱 로거를 전부 꺼버렸다.
    그 시점 이후 로그가 하나도 안 남던 원인.
    """
    from app.db import run_migrations

    logger = logging.getLogger("filesharer")
    logger.disabled = False
    run_migrations(f"sqlite:///{tmp_path / 'mig.db'}")

    # 전달한 URL이 실제로 쓰였는지 — env.py 가 설정값으로 덮어쓰면 여기가 아니라
    # 저장소 상대경로(./data/app.db)에 만들어진다(CI에서 이 경로가 없어 실패했던 지점).
    assert (tmp_path / "mig.db").exists()
    assert not logger.disabled
    assert not logging.getLogger("uvicorn.error").disabled
