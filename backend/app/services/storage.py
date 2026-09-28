"""스토리지 추상화.

v1은 로컬 디스크(blobs/<uuid>). 원격(S3 호환 R2/MinIO) 어댑터는 StorageBackend를
구현해 교체한다. 서빙·오피스변환·tar는 이 인터페이스만 쓰고 로컬 경로에 의존하지 않는다
(local_copy로 필요할 때만 로컬 파일을 확보).
"""

import contextlib
import hashlib
import io
import shutil
import tempfile
import time
import uuid
from abc import ABC, abstractmethod
from collections.abc import Iterator
from pathlib import Path
from typing import BinaryIO

CHUNK = 1024 * 1024


class FileTooLargeError(Exception):
    pass


class StorageBackend(ABC):
    """blob 저장소 인터페이스. 키는 불투명한 문자열(로컬은 uuid 파일명, R2는 객체 키)."""

    @abstractmethod
    def put_stream(self, stream: BinaryIO, max_bytes: int) -> tuple[str, int, str]:
        """스트리밍 저장. 반환: (storage_key, size, sha256)."""

    def put_bytes(self, data: bytes, max_bytes: int) -> tuple[str, int, str]:
        return self.put_stream(io.BytesIO(data), max_bytes)

    @abstractmethod
    def exists(self, key: str) -> bool: ...

    @abstractmethod
    def size(self, key: str) -> int: ...

    @abstractmethod
    def open_stream(self, key: str) -> BinaryIO:
        """처음부터 끝까지 읽는 바이너리 스트림."""

    def open_range(self, key: str, start: int, length: int) -> BinaryIO:
        """start부터 length바이트 범위를 읽는 스트림. 기본은 open_stream + seek(로컬용).
        원격 백엔드는 get_object(Range=...)로 오버라이드해 효율화한다."""
        stream = self.open_stream(key)
        if start:
            stream.seek(start)
        return stream

    @abstractmethod
    def copy_blob(self, key: str) -> str:
        """기존 blob을 새 키로 복제하고 새 키를 반환."""

    @abstractmethod
    def delete(self, key: str) -> None: ...

    @abstractmethod
    def sha256(self, key: str) -> str:
        """저장된 blob의 sha256 (가능하면 업로드 때 저장한 값을 쓰고 호출을 피한다)."""

    def local_path(self, key: str) -> Path | None:
        """로컬 파일 경로가 있으면 반환(로컬 백엔드). 원격이면 None."""
        return None

    @contextlib.contextmanager
    def local_copy(self, key: str) -> Iterator[Path]:
        """로컬 파일이 꼭 필요한 작업(LibreOffice 변환, tar 묶기)용.
        로컬 백엔드면 원본 경로를 그대로, 원격이면 임시파일로 내려받아 제공."""
        local = self.local_path(key)
        if local is not None:
            yield local
            return
        with tempfile.NamedTemporaryFile(delete=True) as tmp:
            with self.open_stream(key) as src:
                while chunk := src.read(CHUNK):
                    tmp.write(chunk)
            tmp.flush()
            yield Path(tmp.name)


class LocalStorage(StorageBackend):
    def __init__(self, data_dir: str | Path):
        self.blob_dir = Path(data_dir) / "blobs"
        self.blob_dir.mkdir(parents=True, exist_ok=True)

    def path_for(self, key: str) -> Path:
        return self.blob_dir / key

    def local_path(self, key: str) -> Path | None:
        return self.path_for(key)

    def exists(self, key: str) -> bool:
        return bool(key) and self.path_for(key).is_file()

    def size(self, key: str) -> int:
        return self.path_for(key).stat().st_size

    def open_stream(self, key: str) -> BinaryIO:
        return self.path_for(key).open("rb")

    def put_stream(self, stream: BinaryIO, max_bytes: int) -> tuple[str, int, str]:
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

    def copy_blob(self, key: str) -> str:
        new_key = uuid.uuid4().hex
        shutil.copyfile(self.path_for(key), self.path_for(new_key))
        return new_key

    def delete(self, key: str) -> None:
        if key:
            self.path_for(key).unlink(missing_ok=True)

    def sha256(self, key: str) -> str:
        digest = hashlib.sha256()
        with self.path_for(key).open("rb") as fh:
            while chunk := fh.read(CHUNK):
                digest.update(chunk)
        return digest.hexdigest()


class R2Storage(StorageBackend):
    """Cloudflare R2 (S3 호환) 백엔드. local_path=None이라 서빙은 스트리밍 경로를 탄다."""

    def __init__(
        self,
        *,
        endpoint_url: str | None,
        access_key_id: str,
        secret_access_key: str,
        bucket: str,
        region: str = "auto",
        prefix: str = "",
    ):
        import boto3
        from botocore.config import Config as BotoConfig

        self.bucket = bucket
        # 버킷 내 환경 구분용 프리픽스(예: "dev/"). DB의 storage_key는 프리픽스 없는
        # bare uuid로 유지하고, R2 객체 키에만 여기서 프리픽스를 붙인다.
        self.prefix = prefix
        self._client = boto3.client(
            "s3",
            endpoint_url=endpoint_url or None,
            aws_access_key_id=access_key_id,
            aws_secret_access_key=secret_access_key,
            region_name=region,
            config=BotoConfig(signature_version="s3v4", retries={"max_attempts": 3}),
        )

    def _full(self, key: str) -> str:
        """DB의 bare 키 → 실제 R2 객체 키(프리픽스 포함)."""
        return f"{self.prefix}{key}"

    @staticmethod
    def _is_not_found(err) -> bool:  # noqa: ANN001
        code = str(err.response.get("Error", {}).get("Code", ""))
        return code in ("404", "NoSuchKey", "NotFound")

    def put_stream(self, stream: BinaryIO, max_bytes: int) -> tuple[str, int, str]:
        key = uuid.uuid4().hex
        digest = hashlib.sha256()
        size = 0
        # sha·크기·용량제한을 위해 스풀에 담아(작으면 메모리, 크면 임시파일) 한 번에 업로드
        with tempfile.SpooledTemporaryFile(max_size=8 * CHUNK) as spool:
            while chunk := stream.read(CHUNK):
                size += len(chunk)
                if size > max_bytes:
                    raise FileTooLargeError(f"limit {max_bytes} bytes")
                digest.update(chunk)
                spool.write(chunk)
            spool.seek(0)
            self._client.upload_fileobj(spool, self.bucket, self._full(key))
        return key, size, digest.hexdigest()

    def exists(self, key: str) -> bool:
        from botocore.exceptions import ClientError

        if not key:
            return False
        try:
            self._client.head_object(Bucket=self.bucket, Key=self._full(key))
            return True
        except ClientError as err:
            if self._is_not_found(err):
                return False
            raise

    def size(self, key: str) -> int:
        return int(
            self._client.head_object(Bucket=self.bucket, Key=self._full(key))["ContentLength"]
        )

    def open_stream(self, key: str) -> BinaryIO:
        return self._client.get_object(Bucket=self.bucket, Key=self._full(key))["Body"]

    def open_range(self, key: str, start: int, length: int) -> BinaryIO:
        end = start + length - 1
        resp = self._client.get_object(
            Bucket=self.bucket, Key=self._full(key), Range=f"bytes={start}-{end}"
        )
        return resp["Body"]

    def copy_blob(self, key: str) -> str:
        new_key = uuid.uuid4().hex
        self._client.copy_object(
            Bucket=self.bucket,
            Key=self._full(new_key),
            CopySource={"Bucket": self.bucket, "Key": self._full(key)},
        )
        return new_key

    def delete(self, key: str) -> None:
        if key:
            self._client.delete_object(Bucket=self.bucket, Key=self._full(key))

    def sha256(self, key: str) -> str:
        digest = hashlib.sha256()
        body = self.open_stream(key)
        try:
            for chunk in iter(lambda: body.read(CHUNK), b""):
                digest.update(chunk)
        finally:
            body.close()
        return digest.hexdigest()


def build_storage(settings) -> StorageBackend:  # noqa: ANN001
    """설정의 STORAGE_BACKEND에 따라 로컬/R2 백엔드를 만든다."""
    if getattr(settings, "storage_backend", "local") == "r2":
        endpoint = settings.r2_endpoint or (
            f"https://{settings.r2_account_id}.r2.cloudflarestorage.com"
        )
        return R2Storage(
            endpoint_url=endpoint,
            access_key_id=settings.r2_access_key_id,
            secret_access_key=settings.r2_secret_access_key,
            bucket=settings.r2_bucket,
            prefix=getattr(settings, "r2_prefix", ""),
        )
    return LocalStorage(settings.data_dir)


# ── 저장소 사용량 ──────────────────────────────────────────────────────────
# 관리 화면이 "지금 얼마나 쓰고 있나"를 묻는다. R2를 쓰면 **서버 디스크에는 파일이 없어서**
# 디스크 사용량만 보여주면 "파일 본체 0 B"로 뜬다 — 파일이 없다는 뜻으로 읽히지만 실제로는
# 다른 곳에 있다는 뜻이다. 그래서 저장소 쪽 숫자를 따로 낸다.
_USAGE_TTL = 300.0
_usage_cache: tuple[float, dict | None] = (0.0, None)
_USAGE_SCAN_CAP = 50_000  # 객체가 아주 많아지면 관리 화면 때문에 목록을 끝없이 돌 이유는 없다


def _r2_usage(storage: "R2Storage") -> dict:
    """버킷을 **최상위 프리픽스별로** 집계한다(prod/ · backup/ · dev/ …).

    자기 프리픽스만 보면 백업이 얼마나 쌓였는지, 옛 환경 찌꺼기가 남았는지 안 보인다.
    실제로 dev 찌꺼기가 992개 쌓인 적이 있다.
    """
    groups: dict[str, dict] = {}
    scanned = 0
    truncated = False
    token = None
    while True:
        kwargs = {"Bucket": storage.bucket, "MaxKeys": 1000}
        if token:
            kwargs["ContinuationToken"] = token
        res = storage._client.list_objects_v2(**kwargs)
        for obj in res.get("Contents", []):
            head = obj["Key"].split("/", 1)[0] + "/" if "/" in obj["Key"] else "(루트)"
            row = groups.setdefault(head, {"prefix": head, "objects": 0, "bytes": 0})
            row["objects"] += 1
            row["bytes"] += int(obj.get("Size", 0))
            scanned += 1
        if scanned >= _USAGE_SCAN_CAP:
            truncated = True
            break
        if not res.get("IsTruncated"):
            break
        token = res.get("NextContinuationToken")
    rows = sorted(groups.values(), key=lambda r: r["bytes"], reverse=True)
    return {
        "backend": "r2",
        "bucket": storage.bucket,
        "prefixes": rows,
        "objects": sum(r["objects"] for r in rows),
        "bytes": sum(r["bytes"] for r in rows),
        "truncated": truncated,
    }


def _local_usage(storage: "LocalStorage") -> dict:
    files = [f for f in storage.blob_dir.glob("*") if f.is_file()]
    total = sum(f.stat().st_size for f in files)
    return {
        "backend": "local",
        "bucket": str(storage.blob_dir),
        "prefixes": [{"prefix": "blobs/", "objects": len(files), "bytes": total}],
        "objects": len(files),
        "bytes": total,
        "truncated": False,
    }


def storage_usage(storage: StorageBackend, *, ttl: float = _USAGE_TTL) -> dict:
    """저장소 사용량.

    목록 조회가 원격 왕복이라 잠깐 캐시한다(관리 탭을 여러 번 열어도 부담 없게).
    """
    global _usage_cache
    at, cached = _usage_cache
    if cached is not None and time.monotonic() - at < ttl:
        return cached
    if isinstance(storage, R2Storage):
        usage = _r2_usage(storage)
    elif isinstance(storage, LocalStorage):
        usage = _local_usage(storage)
    else:  # 알 수 없는 백엔드 — 숫자를 지어내지 않는다
        usage = {"backend": "unknown", "prefixes": [], "objects": 0, "bytes": 0, "truncated": False}
    _usage_cache = (time.monotonic(), usage)
    return usage
