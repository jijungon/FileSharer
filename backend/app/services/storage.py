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
