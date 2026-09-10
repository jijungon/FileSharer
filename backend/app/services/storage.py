"""스토리지 추상화 — v1은 로컬 디스크(blobs/<uuid>), 추후 S3 호환(R2/MinIO) 어댑터 교체 지점."""

import hashlib
import uuid
from pathlib import Path
from typing import BinaryIO

CHUNK = 1024 * 1024


class FileTooLargeError(Exception):
    pass


class LocalStorage:
    def __init__(self, data_dir: str | Path):
        self.blob_dir = Path(data_dir) / "blobs"
        self.blob_dir.mkdir(parents=True, exist_ok=True)

    def path_for(self, key: str) -> Path:
        return self.blob_dir / key

    def put_stream(self, stream: BinaryIO, max_bytes: int) -> tuple[str, int, str]:
        """스트리밍 저장 (메모리 상수). 반환: (storage_key, size, sha256)."""
        key = uuid.uuid4().hex
        target = self.path_for(key)
        digest = hashlib.sha256()
        size = 0
        try:
            with target.open("wb") as out:
                while chunk := stream.read(CHUNK):
                    size += len(chunk)
                    if size > max_bytes:
                        raise FileTooLargeError(f"limit {max_bytes} bytes")
                    digest.update(chunk)
                    out.write(chunk)
        except FileTooLargeError:
            target.unlink(missing_ok=True)
            raise
        return key, size, digest.hexdigest()

    def put_bytes(self, data: bytes, max_bytes: int) -> tuple[str, int, str]:
        import io

        return self.put_stream(io.BytesIO(data), max_bytes)

    def delete(self, key: str) -> None:
        if key:
            self.path_for(key).unlink(missing_ok=True)

    def sha256(self, key: str) -> str:
        digest = hashlib.sha256()
        with self.path_for(key).open("rb") as fh:
            while chunk := fh.read(CHUNK):
                digest.update(chunk)
        return digest.hexdigest()
