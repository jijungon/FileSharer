"""serve_blob의 원격(스트리밍) 경로 검증 — 로컬 백엔드는 FileResponse라 이 경로를 안 타므로
가짜 원격 백엔드로 Range 처리를 미리 확인한다 (R2 어댑터가 재사용)."""

import hashlib
import io

from fastapi import FastAPI, Request
from fastapi.testclient import TestClient

from app.services.serving import serve_blob
from app.services.storage import StorageBackend


class FakeRemote(StorageBackend):
    """local_path=None이라 serve_blob이 스트리밍 경로를 탄다."""

    def __init__(self, blobs: dict[str, bytes]):
        self.blobs = blobs

    def put_stream(self, stream, max_bytes):  # noqa: ANN001
        raise NotImplementedError

    def exists(self, key: str) -> bool:
        return key in self.blobs

    def size(self, key: str) -> int:
        return len(self.blobs[key])

    def open_stream(self, key: str):
        return io.BytesIO(self.blobs[key])

    def copy_blob(self, key: str) -> str:
        raise NotImplementedError

    def delete(self, key: str) -> None:
        self.blobs.pop(key, None)

    def sha256(self, key: str) -> str:
        return hashlib.sha256(self.blobs[key]).hexdigest()


def _client(storage: StorageBackend) -> TestClient:
    app = FastAPI()

    @app.get("/blob/{key}")
    def get_blob(key: str, request: Request):
        return serve_blob(
            storage,
            key,
            filename="f.bin",
            media_type="application/octet-stream",
            request=request,
        )

    return TestClient(app)


def test_remote_serve_full():
    client = _client(FakeRemote({"k": b"0123456789"}))
    res = client.get("/blob/k")
    assert res.status_code == 200
    assert res.content == b"0123456789"
    assert res.headers["accept-ranges"] == "bytes"
    assert res.headers["content-length"] == "10"


def test_remote_serve_range():
    client = _client(FakeRemote({"k": b"0123456789"}))
    res = client.get("/blob/k", headers={"Range": "bytes=2-5"})
    assert res.status_code == 206
    assert res.content == b"2345"
    assert res.headers["content-range"] == "bytes 2-5/10"
    assert res.headers["content-length"] == "4"


def test_remote_serve_open_ended_range():
    client = _client(FakeRemote({"k": b"0123456789"}))
    res = client.get("/blob/k", headers={"Range": "bytes=7-"})
    assert res.status_code == 206
    assert res.content == b"789"
    assert res.headers["content-range"] == "bytes 7-9/10"


def test_remote_serve_missing_is_410():
    client = _client(FakeRemote({}))
    assert client.get("/blob/nope").status_code == 410
