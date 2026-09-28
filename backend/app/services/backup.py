"""주기 백업 — 공간별 tar.gz + DB 스냅샷을 **별도 프리픽스**에 쌓는다.

왜 둘 다 받나:
  * **tar.gz** — 사람이 풀면 바로 파일이 나온다. 폴더 구조·이름이 그대로 들어 있어
    DB 없이도 "무슨 파일이 있었는지"를 복구할 수 있다.
  * **DB 스냅샷** — 블롭 키는 불투명한 uuid라서 DB가 없으면 운영 저장소의 객체가
    어느 파일인지 알 수 없다. 사용자·팀·공유링크·즐겨찾기도 DB에만 있다.

왜 운영 프리픽스(prod/)와 분리하나: 운영 키를 훑는 정리 스크립트나 실수 한 번에
백업까지 같이 날아가면 백업이 아니다. `backup/` 은 앱이 **쓰기만** 하고 복원은 사람이 한다.

회차 식별은 시각이 아니라 **키 존재 여부**로 한다(`weekly/2026-W39/manifest.json`).
manifest 를 **맨 마지막에** 쓰므로, 도중에 죽으면 다음 틱이 그 회차를 다시 만든다.
컨테이너가 배포 때마다 재시작해도 중복 실행되지 않고, 놓치지도 않는다.
"""

from __future__ import annotations

import gzip
import hashlib
import json
import re
import shutil
import sqlite3
import tempfile
from abc import ABC, abstractmethod
from collections.abc import Iterator
from datetime import datetime
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import Node, Space, User, email_nickname, utcnow
from .permissions import space_display_name
from .storage import StorageBackend
from .tar_stream import collect_space_entries, stream_tar_gz

WEEKLY = "weekly"
MONTHLY = "monthly"
KINDS = (WEEKLY, MONTHLY)

# 회차 이름(2026-W39 / 2026-09)만 허용 — 삭제가 엉뚱한 경로를 훑지 않게 하는 안전장치
STAMP_RE = re.compile(r"^\d{4}-(W\d{2}|\d{2})$")
_UNSAFE = re.compile(r"[^\w가-힣 .()-]+")
_CHUNK = 1024 * 1024


def stamp_for(kind: str, now: datetime) -> str:
    """회차 이름. 주간은 ISO 주(2026-W39), 월간은 2026-09.

    문자열 정렬이 곧 시간 순서가 되도록 0을 채운다(보관 정책이 정렬에 기댄다).
    """
    if kind == WEEKLY:
        iso = now.isocalendar()
        return f"{iso[0]}-W{iso[1]:02d}"
    return now.strftime("%Y-%m")


def safe_name(name: str) -> str:
    """객체 키에 쓸 수 있게 다듬는다(슬래시·제어문자 제거). 한글은 그대로 둔다."""
    cleaned = _UNSAFE.sub("_", name).strip().strip(".")
    return cleaned or "unnamed"


def backup_space_name(db: Session, space: Space) -> str:
    """백업 파일명용 공간 이름.

    개인 공간은 화면에선 전부 '내 공간'이라 그대로 쓰면 사람마다 파일이 겹친다.
    소유자 닉네임을 붙여 구분한다.
    """
    if space.type == "personal":
        owner = db.get(User, space.user_id) if space.user_id else None
        who = email_nickname(owner.email) if owner else (space.user_id or space.id)[:8]
        return f"개인-{who}"
    return space_display_name(db, space)


# ── 백업 저장소 ────────────────────────────────────────────────────────────
class BackupStore(ABC):
    """백업 전용 저장소. 운영 블롭 저장소와 **다른 경로**를 본다."""

    @abstractmethod
    def exists(self, key: str) -> bool: ...

    @abstractmethod
    def put_file(self, key: str, path: Path) -> int: ...

    @abstractmethod
    def put_bytes(self, key: str, data: bytes) -> int: ...

    @abstractmethod
    def list_stamps(self, kind: str) -> list[str]: ...

    @abstractmethod
    def delete_stamp(self, kind: str, stamp: str) -> int: ...

    @abstractmethod
    def read_bytes(self, key: str) -> bytes: ...

    @staticmethod
    def _check_stamp(kind: str, stamp: str) -> None:
        """삭제 대상이 '회차 하나'인지 확인 — 빈 값이나 이상한 값이면 상위 경로를 훑게 된다."""
        if kind not in KINDS or not STAMP_RE.match(stamp):
            raise ValueError(f"삭제할 수 없는 회차: {kind}/{stamp}")


class LocalBackupStore(BackupStore):
    """로컬 디렉토리 백업(개발·테스트용)."""

    def __init__(self, root: str | Path):
        self.root = Path(root)

    def _path(self, key: str) -> Path:
        return self.root / key

    def exists(self, key: str) -> bool:
        return self._path(key).exists()

    def put_file(self, key: str, path: Path) -> int:
        dest = self._path(key)
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(path, dest)
        return dest.stat().st_size

    def put_bytes(self, key: str, data: bytes) -> int:
        dest = self._path(key)
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(data)
        return len(data)

    def read_bytes(self, key: str) -> bytes:
        return self._path(key).read_bytes()

    def list_stamps(self, kind: str) -> list[str]:
        base = self.root / kind
        if not base.is_dir():
            return []
        return sorted(d.name for d in base.iterdir() if d.is_dir())

    def delete_stamp(self, kind: str, stamp: str) -> int:
        self._check_stamp(kind, stamp)
        target = self.root / kind / stamp
        if not target.is_dir():
            return 0
        removed = sum(1 for _ in target.rglob("*") if _.is_file())
        shutil.rmtree(target)
        return removed


class R2BackupStore(BackupStore):
    """R2의 별도 프리픽스(기본 `backup/`). 운영 프리픽스와 섞이지 않는다."""

    def __init__(self, *, client, bucket: str, prefix: str):  # noqa: ANN001
        self._client = client
        self.bucket = bucket
        self.prefix = prefix if prefix.endswith("/") or not prefix else prefix + "/"

    def _full(self, key: str) -> str:
        return f"{self.prefix}{key}"

    def exists(self, key: str) -> bool:
        from botocore.exceptions import ClientError

        try:
            self._client.head_object(Bucket=self.bucket, Key=self._full(key))
            return True
        except ClientError as err:
            code = str(err.response.get("Error", {}).get("Code", ""))
            if code in ("404", "NoSuchKey", "NotFound"):
                return False
            raise

    def put_file(self, key: str, path: Path) -> int:
        with path.open("rb") as fh:
            self._client.upload_fileobj(fh, self.bucket, self._full(key))
        return path.stat().st_size

    def put_bytes(self, key: str, data: bytes) -> int:
        self._client.put_object(Bucket=self.bucket, Key=self._full(key), Body=data)
        return len(data)

    def read_bytes(self, key: str) -> bytes:
        return self._client.get_object(Bucket=self.bucket, Key=self._full(key))["Body"].read()

    def list_stamps(self, kind: str) -> list[str]:
        out: list[str] = []
        token = None
        base = f"{self.prefix}{kind}/"
        while True:
            kw = {"Bucket": self.bucket, "Prefix": base, "Delimiter": "/"}
            if token:
                kw["ContinuationToken"] = token
            res = self._client.list_objects_v2(**kw)
            out.extend(
                cp["Prefix"][len(base) :].rstrip("/") for cp in res.get("CommonPrefixes", [])
            )
            if not res.get("IsTruncated"):
                break
            token = res.get("NextContinuationToken")
        return sorted(p for p in out if p)

    def delete_stamp(self, kind: str, stamp: str) -> int:
        self._check_stamp(kind, stamp)
        base = f"{self.prefix}{kind}/{stamp}/"
        removed = 0
        token = None
        while True:
            kw = {"Bucket": self.bucket, "Prefix": base}
            if token:
                kw["ContinuationToken"] = token
            res = self._client.list_objects_v2(**kw)
            keys = [{"Key": o["Key"]} for o in res.get("Contents", [])]
            for i in range(0, len(keys), 1000):
                self._client.delete_objects(
                    Bucket=self.bucket, Delete={"Objects": keys[i : i + 1000]}
                )
            removed += len(keys)
            if not res.get("IsTruncated"):
                break
            token = res.get("NextContinuationToken")
        return removed


def build_backup_store(settings) -> BackupStore:  # noqa: ANN001
    """설정에 맞는 백업 저장소. R2면 backup/ 프리픽스, 아니면 data_dir/backups."""
    if getattr(settings, "storage_backend", "local") == "r2":
        import boto3
        from botocore.config import Config as BotoConfig

        endpoint = settings.r2_endpoint or (
            f"https://{settings.r2_account_id}.r2.cloudflarestorage.com"
        )
        client = boto3.client(
            "s3",
            endpoint_url=endpoint or None,
            aws_access_key_id=settings.r2_access_key_id,
            aws_secret_access_key=settings.r2_secret_access_key,
            region_name="auto",
            config=BotoConfig(signature_version="s3v4", retries={"max_attempts": 3}),
        )
        return R2BackupStore(
            client=client, bucket=settings.r2_bucket, prefix=settings.backup_prefix
        )
    return LocalBackupStore(Path(settings.data_dir) / "backups")


# ── 한 회차 만들기 ─────────────────────────────────────────────────────────
def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        while chunk := fh.read(_CHUNK):
            digest.update(chunk)
    return digest.hexdigest()


def _space_roots(db: Session, space: Space) -> list[Node]:
    return list(
        db.scalars(
            select(Node).where(
                Node.space_id == space.id,
                Node.parent_id.is_(None),
                Node.deleted_at.is_(None),
            )
        ).all()
    )


def _write_space_tar(
    db: Session, storage: StorageBackend, store: BackupStore, space: Space, base: str
) -> dict:
    name = backup_space_name(db, space)
    entries = list(collect_space_entries(db, name, _space_roots(db, space)))
    key = f"{base}/spaces/{safe_name(name)}.tar.gz"
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td) / "space.tar.gz"
        with tmp.open("wb") as fh:
            for chunk in stream_tar_gz(storage, entries):
                fh.write(chunk)
        size = store.put_file(key, tmp)
        sha = _sha256_file(tmp)
    return {
        "space": name,
        "type": space.type,
        "key": key,
        "files": sum(1 for node, _ in entries if node is not None),
        "bytes": size,
        "sha256": sha,
    }


def _snapshot_db(settings, store: BackupStore, base: str) -> dict | None:  # noqa: ANN001
    """SQLite를 일관된 상태로 떠서 gzip으로 올린다.

    WAL 모드라 파일을 그냥 복사하면 반쪽짜리가 될 수 있다. `VACUUM INTO`는 트랜잭션
    경계에서 완결된 사본을 만든다.
    """
    url = str(settings.database_url)
    if not url.startswith("sqlite"):
        return None  # 다른 DB면 여기서 뜨지 않는다(전용 도구로 받아야 한다)
    src = url.split("///", 1)[-1]
    if not Path(src).exists():
        return None
    key = f"{base}/app.db.gz"
    with tempfile.TemporaryDirectory() as td:
        snap = Path(td) / "app.db"
        con = sqlite3.connect(src)
        try:
            con.execute("VACUUM INTO ?", (str(snap),))
        finally:
            con.close()
        gz = Path(td) / "app.db.gz"
        with snap.open("rb") as src_fh, gzip.open(gz, "wb") as out:
            shutil.copyfileobj(src_fh, out, _CHUNK)
        size = store.put_file(key, gz)
        return {
            "key": key,
            "bytes": size,
            "sha256": _sha256_file(gz),
            "raw_bytes": snap.stat().st_size,
        }


def run_backup(
    db: Session,
    storage: StorageBackend,
    store: BackupStore,
    kind: str,
    *,
    settings,  # noqa: ANN001
    now: datetime | None = None,
    force: bool = False,
) -> dict | None:
    """한 회차 백업. 이미 그 회차가 있으면 **아무것도 하지 않고** None."""
    if kind not in KINDS:
        raise ValueError(f"알 수 없는 백업 종류: {kind}")
    stamp = stamp_for(kind, now or utcnow())
    base = f"{kind}/{stamp}"
    manifest_key = f"{base}/manifest.json"
    if not force and store.exists(manifest_key):
        return None

    spaces = list(db.scalars(select(Space).order_by(Space.type, Space.id)).all())
    items = [_write_space_tar(db, storage, store, space, base) for space in spaces]
    manifest = {
        "kind": kind,
        "stamp": stamp,
        "created_at": utcnow().isoformat(),
        "spaces": items,
        "db": _snapshot_db(settings, store, base),
        "total_files": sum(i["files"] for i in items),
        "total_bytes": sum(i["bytes"] for i in items),
    }
    # manifest 를 맨 마지막에 — 이게 있으면 '완결된 회차'다(중간에 죽으면 다음 틱이 다시 만든다)
    store.put_bytes(manifest_key, json.dumps(manifest, ensure_ascii=False, indent=2).encode())
    return manifest


def prune(store: BackupStore, kind: str, keep: int) -> list[str]:
    """오래된 회차 삭제. keep 이하면 아무것도 안 지운다."""
    if keep <= 0:
        return []
    stamps = [s for s in store.list_stamps(kind) if STAMP_RE.match(s)]
    drop = sorted(stamps)[:-keep] if len(stamps) > keep else []
    for stamp in drop:
        store.delete_stamp(kind, stamp)
    return drop


def run_due(
    db: Session,
    storage: StorageBackend,
    store: BackupStore,
    settings,  # noqa: ANN001
    *,
    now: datetime | None = None,
) -> list[str]:
    """지금 돌아야 할 회차를 돌고, 성공한 종류만 보관 정책을 적용한다."""
    at = now or utcnow()
    keeps = {
        WEEKLY: settings.backup_keep_weekly,
        MONTHLY: settings.backup_keep_monthly,
    }
    lines: list[str] = []
    for kind in KINDS:
        manifest = run_backup(db, storage, store, kind, settings=settings, now=at)
        if manifest is None:
            continue
        dropped = prune(store, kind, keeps[kind])
        line = (
            f"{kind} {manifest['stamp']} — 공간 {len(manifest['spaces'])}개 · "
            f"파일 {manifest['total_files']}개 · {manifest['total_bytes']} bytes"
        )
        if dropped:
            line += f" · 오래된 회차 {len(dropped)}개 삭제({', '.join(dropped)})"
        lines.append(line)
    return lines


def list_runs(store: BackupStore) -> Iterator[dict]:
    """쌓인 회차를 최신순으로 훑는다(스크립트·점검용)."""
    for kind in KINDS:
        for stamp in sorted(store.list_stamps(kind), reverse=True):
            key = f"{kind}/{stamp}/manifest.json"
            if not store.exists(key):
                yield {"kind": kind, "stamp": stamp, "manifest": None}
                continue
            yield {"kind": kind, "stamp": stamp, "manifest": json.loads(store.read_bytes(key))}
