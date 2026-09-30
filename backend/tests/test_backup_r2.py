"""R2BackupStore 검증 — 프로덕션 백업이 실제로 지나가는 경로.

`test_backup.py` 는 LocalBackupStore 만 쓴다. 그런데 prod 는 `storage_backend=r2` 이고
백업 자동 실행은 `APP_ENV=prod` 에서만 돈다 — **자동으로 돌아가는 유일한 구현이
검증되지 않은 쪽**이었다. 백업은 마지막 방어선이라 여기가 조용히 틀리면 알 방법이 없다.

두 가지 도구를 섞어 쓴다:
  * **moto** — 실제 S3 의미론(CommonPrefixes 모양, 404 코드, 삭제 반영)을 그대로 확인한다.
  * **손으로 만든 가짜 클라이언트** — 페이지네이션과 1000키 배치 경계는 객체를 1000개 넘게
    만들지 않고는 moto 로 재현할 수 없다. 호출 횟수와 인자를 직접 들여다보려는 목적도 있다.
"""

import pytest

boto3 = pytest.importorskip("boto3")
pytest.importorskip("moto")
from botocore.exceptions import ClientError  # noqa: E402
from moto import mock_aws  # noqa: E402

from app.services import backup  # noqa: E402
from app.services.backup import R2BackupStore  # noqa: E402

BUCKET = "filesharer-backup-test"
PREFIX = "backup/"


def _raw():
    return boto3.client("s3", region_name="us-east-1")


def _make_store(prefix: str = PREFIX) -> R2BackupStore:
    client = _raw()
    client.create_bucket(Bucket=BUCKET)
    return R2BackupStore(client=client, bucket=BUCKET, prefix=prefix)


# ── 프리픽스 ───────────────────────────────────────────────────────────────
@pytest.mark.parametrize(
    ("given", "expected"),
    [("backup/", "backup/"), ("backup", "backup/"), ("", "")],
)
def test_r2_backup_prefix_is_normalized(given, expected):
    """슬래시를 빼먹어도 붙여준다. 빈 프리픽스는 빈 채로 둔다(버킷 루트)."""
    store = R2BackupStore(client=object(), bucket=BUCKET, prefix=given)
    assert store.prefix == expected


@mock_aws
def test_r2_backup_writes_under_prefix():
    """객체는 반드시 프리픽스 아래에 놓인다 — 운영 키(prod/)와 섞이면 정리 한 번에 같이 날아간다."""
    store = _make_store()
    store.put_bytes("weekly/2026-W39/manifest.json", b"{}")

    keys = [o["Key"] for o in _raw().list_objects_v2(Bucket=BUCKET).get("Contents", [])]
    assert keys == ["backup/weekly/2026-W39/manifest.json"]


# ── 왕복 ───────────────────────────────────────────────────────────────────
@mock_aws
def test_r2_backup_roundtrip(tmp_path):
    """put_bytes / put_file 로 넣은 것이 read_bytes 로 그대로 나오고, 크기를 옳게 돌려준다."""
    store = _make_store()

    assert store.put_bytes("weekly/2026-W39/manifest.json", b'{"ok":true}') == 11
    assert store.read_bytes("weekly/2026-W39/manifest.json") == b'{"ok":true}'

    src = tmp_path / "space.tar.gz"
    src.write_bytes(b"tarball-bytes")
    assert store.put_file("weekly/2026-W39/space.tar.gz", src) == 13
    assert store.read_bytes("weekly/2026-W39/space.tar.gz") == b"tarball-bytes"


@mock_aws
def test_r2_backup_exists():
    """있으면 True, 없으면 False. 회차 식별이 이 값 하나에 걸려 있다."""
    store = _make_store()
    assert store.exists("weekly/2026-W39/manifest.json") is False
    store.put_bytes("weekly/2026-W39/manifest.json", b"{}")
    assert store.exists("weekly/2026-W39/manifest.json") is True


def test_r2_backup_exists_reraises_unexpected_error():
    """권한 오류를 '없음'으로 삼키면 그 회차를 통째로 다시 만든다 — 404 만 False 로 본다."""

    class Forbidden:
        def head_object(self, **_):
            raise ClientError({"Error": {"Code": "403", "Message": "denied"}}, "HeadObject")

    store = R2BackupStore(client=Forbidden(), bucket=BUCKET, prefix=PREFIX)
    with pytest.raises(ClientError):
        store.exists("weekly/2026-W39/manifest.json")


@pytest.mark.parametrize("code", ["404", "NoSuchKey", "NotFound"])
def test_r2_backup_exists_false_on_missing_codes(code):
    """S3 구현마다 '없음'을 다른 코드로 준다 — 셋 다 False 여야 한다."""

    class Missing:
        def head_object(self, **_):
            raise ClientError({"Error": {"Code": code, "Message": "nope"}}, "HeadObject")

    store = R2BackupStore(client=Missing(), bucket=BUCKET, prefix=PREFIX)
    assert store.exists("weekly/2026-W39/manifest.json") is False


# ── 회차 목록 ──────────────────────────────────────────────────────────────
@mock_aws
def test_r2_backup_list_stamps_separates_kinds_and_sorts():
    """주간·월간이 섞이지 않고, 문자열 정렬이 곧 시간 순서다(보관 정책이 여기 기댄다)."""
    store = _make_store()
    for key in (
        "weekly/2026-W40/manifest.json",
        "weekly/2026-W39/manifest.json",
        "weekly/2026-W39/space.tar.gz",
        "monthly/2026-09/manifest.json",
    ):
        store.put_bytes(key, b"{}")

    assert store.list_stamps("weekly") == ["2026-W39", "2026-W40"]
    assert store.list_stamps("monthly") == ["2026-09"]


@mock_aws
def test_r2_backup_list_stamps_empty_when_nothing_yet():
    """첫 기동엔 아무것도 없다 — 빈 목록이어야 하고 예외가 아니어야 한다."""
    assert _make_store().list_stamps("weekly") == []


# ── 회차 삭제 ──────────────────────────────────────────────────────────────
@mock_aws
def test_r2_backup_delete_stamp_removes_only_that_round():
    """지울 회차만 지운다. 옆 회차나 다른 종류를 건드리면 보관 정책이 백업을 지우는 꼴이다."""
    store = _make_store()
    for key in (
        "weekly/2026-W39/manifest.json",
        "weekly/2026-W39/space.tar.gz",
        "weekly/2026-W40/manifest.json",
        "monthly/2026-09/manifest.json",
    ):
        store.put_bytes(key, b"{}")

    assert store.delete_stamp("weekly", "2026-W39") == 2

    left = [o["Key"] for o in _raw().list_objects_v2(Bucket=BUCKET).get("Contents", [])]
    assert sorted(left) == [
        "backup/monthly/2026-09/manifest.json",
        "backup/weekly/2026-W40/manifest.json",
    ]


@mock_aws
def test_r2_backup_delete_stamp_missing_is_zero():
    """없는 회차를 지워도 0 이고 조용하다(정리 작업이 중간에 멈추면 안 된다)."""
    assert _make_store().delete_stamp("weekly", "2026-W01") == 0


@pytest.mark.parametrize(
    ("kind", "stamp"),
    [
        ("weekly", ""),  # 빈 값이면 weekly/ 전체를 훑는다
        ("weekly", ".."),
        ("weekly", "2026-W39/../2026-W40"),
        ("../etc", "2026-W39"),
        ("daily", "2026-W39"),  # 모르는 종류
    ],
)
@mock_aws
def test_r2_backup_delete_stamp_rejects_unsafe(kind, stamp):
    """이상한 회차 이름은 거부한다 — 삭제가 상위 경로를 훑으면 백업 전체가 날아간다."""
    store = _make_store()
    store.put_bytes("weekly/2026-W39/manifest.json", b"{}")

    with pytest.raises(ValueError):
        store.delete_stamp(kind, stamp)

    assert store.exists("weekly/2026-W39/manifest.json") is True


# ── 페이지네이션과 배치 경계 (가짜 클라이언트) ──────────────────────────────
class FakeListClient:
    """list_objects_v2 를 정해진 페이지로 돌려주고, 호출을 기록하는 가짜.

    객체를 1000개 넘게 만들지 않고 페이지네이션·배치 경계를 보려고 쓴다.
    """

    def __init__(self, pages):
        self._pages = pages
        self.list_calls = []
        self.deleted_batches = []

    def list_objects_v2(self, **kw):
        self.list_calls.append(kw)
        idx = 0
        if kw.get("ContinuationToken"):
            idx = int(kw["ContinuationToken"])
        return self._pages[idx]

    def delete_objects(self, *, Bucket, Delete):  # noqa: N803 - boto3 인자 이름
        self.deleted_batches.append(len(Delete["Objects"]))
        return {"Deleted": Delete["Objects"]}


def test_r2_backup_list_stamps_follows_pagination():
    """첫 페이지에서 멈추면 오래된 회차를 못 보고 보관 정책이 영영 안 지운다."""
    base = f"{PREFIX}weekly/"
    client = FakeListClient(
        [
            {
                "CommonPrefixes": [{"Prefix": f"{base}2026-W39/"}],
                "IsTruncated": True,
                "NextContinuationToken": "1",
            },
            {"CommonPrefixes": [{"Prefix": f"{base}2026-W40/"}], "IsTruncated": False},
        ]
    )
    store = R2BackupStore(client=client, bucket=BUCKET, prefix=PREFIX)

    assert store.list_stamps("weekly") == ["2026-W39", "2026-W40"]
    assert len(client.list_calls) == 2
    assert client.list_calls[1]["ContinuationToken"] == "1"
    # 종류별로만 훑어야 한다 — Delimiter 가 빠지면 회차가 아니라 파일 키가 올라온다
    assert client.list_calls[0]["Delimiter"] == "/"
    assert client.list_calls[0]["Prefix"] == base


def test_r2_backup_delete_stamp_follows_pagination_and_counts_all():
    """두 번째 페이지를 놓치면 지운 줄 알았던 회차가 일부 남는다."""
    base = f"{PREFIX}weekly/2026-W39/"
    client = FakeListClient(
        [
            {
                "Contents": [{"Key": f"{base}a"}, {"Key": f"{base}b"}],
                "IsTruncated": True,
                "NextContinuationToken": "1",
            },
            {"Contents": [{"Key": f"{base}c"}], "IsTruncated": False},
        ]
    )
    store = R2BackupStore(client=client, bucket=BUCKET, prefix=PREFIX)

    assert store.delete_stamp("weekly", "2026-W39") == 3
    assert client.deleted_batches == [2, 1]


def test_r2_backup_delete_stamp_splits_batches_at_1000():
    """delete_objects 는 한 번에 1000개까지다. 1001개를 한 번에 보내면 통째로 거절당한다."""
    base = f"{PREFIX}weekly/2026-W39/"
    client = FakeListClient(
        [{"Contents": [{"Key": f"{base}{i}"} for i in range(1500)], "IsTruncated": False}]
    )
    store = R2BackupStore(client=client, bucket=BUCKET, prefix=PREFIX)

    assert store.delete_stamp("weekly", "2026-W39") == 1500
    assert client.deleted_batches == [1000, 500]


# ── 설정에서 고르기 ────────────────────────────────────────────────────────
def test_build_backup_store_picks_r2_and_keeps_prefix(tmp_path):
    """storage_backend=r2 면 R2BackupStore 를, 엔드포인트가 비면 계정 ID 로 짓는다."""

    class FakeSettings:
        storage_backend = "r2"
        data_dir = str(tmp_path)
        backup_prefix = "backup/"
        r2_endpoint = ""
        r2_account_id = "acct123"
        r2_access_key_id = "k"
        r2_secret_access_key = "s"
        r2_bucket = "filesharer"

    store = backup.build_backup_store(FakeSettings())

    assert isinstance(store, R2BackupStore)
    assert store.bucket == "filesharer"
    assert store.prefix == "backup/"
    assert store._client.meta.endpoint_url == "https://acct123.r2.cloudflarestorage.com"


def test_build_backup_store_honors_explicit_endpoint(tmp_path):
    """엔드포인트를 직접 주면 그것을 쓴다(계정 ID 로 덮어쓰지 않는다)."""

    class FakeSettings:
        storage_backend = "r2"
        data_dir = str(tmp_path)
        backup_prefix = "backup/"
        r2_endpoint = "https://custom.example.com"
        r2_account_id = "acct123"
        r2_access_key_id = "k"
        r2_secret_access_key = "s"
        r2_bucket = "filesharer"

    store = backup.build_backup_store(FakeSettings())
    assert store._client.meta.endpoint_url == "https://custom.example.com"
