"""R2Storage 어댑터 검증 — moto로 S3를 모킹(실제 R2 자격증명 불필요).
R2는 S3 호환이라 moto가 그대로 대역할 수 있다."""

import hashlib
import io

import pytest

boto3 = pytest.importorskip("boto3")
pytest.importorskip("moto")
from moto import mock_aws  # noqa: E402

from app.services.storage import (  # noqa: E402
    FileTooLargeError,
    R2Storage,
    build_storage,
)

BUCKET = "filesharer-test"


def _make_r2() -> R2Storage:
    # 버킷 먼저 생성(moto). endpoint_url=None이면 moto가 가로챈다.
    boto3.client("s3", region_name="us-east-1").create_bucket(Bucket=BUCKET)
    return R2Storage(
        endpoint_url=None,
        access_key_id="k",
        secret_access_key="s",
        bucket=BUCKET,
        region="us-east-1",
    )


@mock_aws
def test_r2_put_get_roundtrip():
    st = _make_r2()
    key, size, sha = st.put_stream(io.BytesIO(b"hello r2"), 10_000)
    assert size == 8
    assert sha == hashlib.sha256(b"hello r2").hexdigest()
    assert st.exists(key) is True
    assert st.size(key) == 8
    assert st.open_stream(key).read() == b"hello r2"
    assert st.sha256(key) == sha


def _make_r2_prefixed(prefix: str) -> R2Storage:
    return R2Storage(
        endpoint_url=None,
        access_key_id="k",
        secret_access_key="s",
        bucket=BUCKET,
        region="us-east-1",
        prefix=prefix,
    )


@mock_aws
def test_r2_prefix_isolates_and_returns_bare_key():
    """프리픽스는 실제 R2 객체 키에만 붙고, 반환(DB) 키는 프리픽스 없는 bare uuid.
    같은 버킷을 다른 프리픽스로 쓰면 서로 객체가 안 보인다(dev/prod 격리)."""
    from botocore.exceptions import ClientError

    raw = boto3.client("s3", region_name="us-east-1")
    raw.create_bucket(Bucket=BUCKET)
    prod = _make_r2_prefixed("prod/")
    dev = _make_r2_prefixed("dev/")

    key, *_ = prod.put_stream(io.BytesIO(b"prod-data"), 10_000)
    assert "/" not in key  # 반환 키는 bare uuid (프리픽스 없음)
    # 실제 객체는 prod/<key> 에 저장된다
    assert raw.get_object(Bucket=BUCKET, Key=f"prod/{key}")["Body"].read() == b"prod-data"
    with pytest.raises(ClientError):
        raw.get_object(Bucket=BUCKET, Key=key)  # 루트엔 없음
    # 같은 bare 키라도 dev 프리픽스로는 안 보인다(격리)
    assert prod.exists(key) is True
    assert dev.exists(key) is False


@mock_aws
def test_r2_prefix_copy_and_delete_stay_in_prefix():
    boto3.client("s3", region_name="us-east-1").create_bucket(Bucket=BUCKET)
    st = _make_r2_prefixed("prod/")
    key, *_ = st.put_stream(io.BytesIO(b"dup"), 10_000)
    new_key = st.copy_blob(key)
    assert "/" not in new_key
    assert st.open_stream(new_key).read() == b"dup"
    st.delete(key)
    assert st.exists(key) is False
    assert st.exists(new_key) is True


def test_build_storage_passes_prefix():
    class R2Set:
        storage_backend = "r2"
        r2_endpoint = ""
        r2_account_id = "acc"
        r2_access_key_id = "k"
        r2_secret_access_key = "s"
        r2_bucket = "b"
        r2_prefix = "prod/"
        data_dir = "./data"

    st = build_storage(R2Set())
    assert isinstance(st, R2Storage)
    assert st.prefix == "prod/"


@mock_aws
def test_r2_range_read():
    st = _make_r2()
    key, *_ = st.put_stream(io.BytesIO(b"0123456789"), 10_000)
    assert st.open_range(key, 2, 4).read() == b"2345"  # bytes 2-5


@mock_aws
def test_r2_copy_and_delete():
    st = _make_r2()
    key, *_ = st.put_stream(io.BytesIO(b"dup"), 10_000)
    new_key = st.copy_blob(key)
    assert new_key != key
    assert st.open_stream(new_key).read() == b"dup"
    st.delete(key)
    assert st.exists(key) is False
    assert st.exists(new_key) is True  # 복사본은 살아있음


@mock_aws
def test_r2_too_large_raises():
    st = _make_r2()
    with pytest.raises(FileTooLargeError):
        st.put_stream(io.BytesIO(b"x" * 100), 10)


@mock_aws
def test_r2_missing_key_is_false():
    st = _make_r2()
    assert st.exists("does-not-exist") is False


def test_build_storage_selects_backend_and_endpoint():
    """설정에 따라 R2/로컬을 고르고, R2 엔드포인트를 account_id로 구성하는지."""
    from app.services.storage import LocalStorage

    class R2Set:
        storage_backend = "r2"
        r2_endpoint = ""  # account_id로 자동 구성되는 경로
        r2_account_id = "acc123"
        r2_access_key_id = "k"
        r2_secret_access_key = "s"
        r2_bucket = "b"
        data_dir = "./data"

    r2 = build_storage(R2Set())
    assert isinstance(r2, R2Storage)
    assert r2._client.meta.endpoint_url == "https://acc123.r2.cloudflarestorage.com"

    class LocalSet:
        storage_backend = "local"
        data_dir = "/tmp/fs-local"

    assert isinstance(build_storage(LocalSet()), LocalStorage)


@mock_aws
def test_stream_tar_gz_reads_from_r2():
    """폴더 tar 다운로드가 R2 백엔드에서도 각 blob을 스트리밍해 담는지."""
    import tarfile

    from app.models import Node
    from app.services.tar_stream import stream_tar_gz

    st = _make_r2()
    k1, *_ = st.put_stream(io.BytesIO(b"file-one"), 10_000)
    k2, *_ = st.put_stream(io.BytesIO(b"two"), 10_000)
    n1 = Node(type="file", name="a.txt", size=8, storage_key=k1)
    n2 = Node(type="file", name="b.txt", size=3, storage_key=k2)
    entries = [(None, "root"), (n1, "root/a.txt"), (n2, "root/b.txt")]

    data = b"".join(stream_tar_gz(st, entries))
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as tar:
        assert tar.extractfile("root/a.txt").read() == b"file-one"
        assert tar.extractfile("root/b.txt").read() == b"two"


@mock_aws
def test_serve_blob_streams_r2_with_range():
    """serve_blob이 R2 백엔드(StreamingBody)로 전체·부분전송을 제대로 하는지."""
    from fastapi import FastAPI, Request
    from fastapi.testclient import TestClient

    from app.services.serving import serve_blob

    st = _make_r2()
    key, *_ = st.put_stream(io.BytesIO(b"0123456789"), 10_000)

    app = FastAPI()

    @app.get("/b/{k}")
    def get_blob(k: str, request: Request):
        return serve_blob(
            st, k, filename="f.bin", media_type="application/octet-stream", request=request
        )

    client = TestClient(app)
    assert client.get(f"/b/{key}").content == b"0123456789"
    ranged = client.get(f"/b/{key}", headers={"Range": "bytes=3-6"})
    assert ranged.status_code == 206
    assert ranged.content == b"3456"
    assert ranged.headers["content-range"] == "bytes 3-6/10"


@mock_aws
def test_migrate_root_to_prefix():
    """루트 bare 키만 프리픽스 아래로 이동, 이미 프리픽스 있는 키는 보존, idempotent."""
    from botocore.exceptions import ClientError

    from scripts.migrate_r2_prefix import migrate_root_to_prefix

    c = boto3.client("s3", region_name="us-east-1")
    c.create_bucket(Bucket=BUCKET)
    c.put_object(Bucket=BUCKET, Key="aaa", Body=b"1")  # 루트 bare 키
    c.put_object(Bucket=BUCKET, Key="bbb", Body=b"2")  # 루트 bare 키
    c.put_object(Bucket=BUCKET, Key="prod/ccc", Body=b"3")  # 이미 프리픽스 있음

    # dry-run: 목록만, 실제 변화 없음
    dry = migrate_root_to_prefix(c, BUCKET, "dev/", apply=False)
    assert sorted(s for s, _ in dry["moved"]) == ["aaa", "bbb"]
    assert dry["skipped"] == 1
    assert c.get_object(Bucket=BUCKET, Key="aaa")["Body"].read() == b"1"

    # apply: 실제 이동
    res = migrate_root_to_prefix(c, BUCKET, "dev/", apply=True)
    assert len(res["moved"]) == 2
    assert c.get_object(Bucket=BUCKET, Key="dev/aaa")["Body"].read() == b"1"
    assert c.get_object(Bucket=BUCKET, Key="dev/bbb")["Body"].read() == b"2"
    with pytest.raises(ClientError):
        c.get_object(Bucket=BUCKET, Key="aaa")  # 루트 원본은 삭제됨
    assert c.get_object(Bucket=BUCKET, Key="prod/ccc")["Body"].read() == b"3"  # 보존

    # idempotent
    assert migrate_root_to_prefix(c, BUCKET, "dev/", apply=True)["moved"] == []
