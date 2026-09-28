"""저장소 사용량 집계 — 관리 화면이 "지금 얼마나 쓰고 있나"를 묻는 곳.

R2를 쓰면 파일 본체가 서버 디스크에 없다. 디스크 숫자만 보여주면 "파일 본체 0 B"가 되어
'파일이 없다'로 읽힌다. 실제로 그렇게 보였고, 이 집계가 그걸 바로잡는다.
"""

import pytest

from app.services import storage as storage_mod
from app.services.storage import LocalStorage, storage_usage

boto3 = pytest.importorskip("boto3")
pytest.importorskip("moto")
from moto import mock_aws  # noqa: E402

from app.services.storage import R2Storage  # noqa: E402

BUCKET = "filesharer-usage-test"


@pytest.fixture(autouse=True)
def _clear_cache():
    storage_mod._usage_cache = (0.0, None)
    yield
    storage_mod._usage_cache = (0.0, None)


def _r2() -> R2Storage:
    boto3.client("s3", region_name="us-east-1").create_bucket(Bucket=BUCKET)
    return R2Storage(
        endpoint_url=None,
        access_key_id="k",
        secret_access_key="s",
        bucket=BUCKET,
        prefix="prod/",
    )


@mock_aws
def test_groups_by_top_level_prefix():
    """자기 프리픽스만 보면 백업이 얼마나 쌓였는지, 옛 찌꺼기가 남았는지 안 보인다."""
    r2 = _r2()
    client = r2._client
    client.put_object(Bucket=BUCKET, Key="prod/aaa", Body=b"x" * 100)
    client.put_object(Bucket=BUCKET, Key="prod/bbb", Body=b"x" * 200)
    client.put_object(Bucket=BUCKET, Key="backup/weekly/2026-W40/app.db.gz", Body=b"x" * 500)
    client.put_object(Bucket=BUCKET, Key="dev/ccc", Body=b"x" * 50)

    usage = storage_usage(r2)

    assert usage["backend"] == "r2"
    assert usage["bucket"] == BUCKET
    assert usage["objects"] == 4
    assert usage["bytes"] == 850
    rows = {row["prefix"]: row for row in usage["prefixes"]}
    assert rows["prod/"] == {"prefix": "prod/", "objects": 2, "bytes": 300}
    assert rows["backup/"] == {"prefix": "backup/", "objects": 1, "bytes": 500}
    assert rows["dev/"] == {"prefix": "dev/", "objects": 1, "bytes": 50}
    # 큰 것부터 — 뭐가 자리를 차지하는지 먼저 보여야 한다
    assert [r["prefix"] for r in usage["prefixes"]][0] == "backup/"


@mock_aws
def test_counts_whole_bucket_not_just_own_prefix():
    """R2_PREFIX 가 prod/ 라도 backup/·dev/ 까지 집계해야 의미가 있다."""
    r2 = _r2()
    r2._client.put_object(Bucket=BUCKET, Key="backup/x", Body=b"x")
    usage = storage_usage(r2)
    assert any(row["prefix"] == "backup/" for row in usage["prefixes"])


@mock_aws
def test_empty_bucket():
    usage = storage_usage(_r2())
    assert usage["objects"] == 0 and usage["bytes"] == 0 and usage["prefixes"] == []


@mock_aws
def test_cached_between_calls():
    """관리 탭을 여러 번 열어도 목록 조회가 매번 나가면 안 된다."""
    r2 = _r2()
    r2._client.put_object(Bucket=BUCKET, Key="prod/a", Body=b"x")
    first = storage_usage(r2)
    r2._client.put_object(Bucket=BUCKET, Key="prod/b", Body=b"xx")
    assert storage_usage(r2)["objects"] == first["objects"]  # 캐시가 살아 있다
    assert storage_usage(r2, ttl=0)["objects"] == 2  # 캐시를 끄면 새로 본다


def test_local_backend_reports_blob_dir(tmp_path):
    local = LocalStorage(tmp_path)
    (local.blob_dir / "one").write_bytes(b"x" * 10)
    (local.blob_dir / "two").write_bytes(b"x" * 20)

    usage = storage_usage(local, ttl=0)

    assert usage["backend"] == "local"
    assert usage["objects"] == 2
    assert usage["bytes"] == 30


def test_unknown_backend_does_not_invent_numbers():
    class Odd:
        pass

    usage = storage_usage(Odd(), ttl=0)
    assert usage["backend"] == "unknown"
    assert usage["objects"] == 0 and usage["prefixes"] == []
