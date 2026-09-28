"""폴더 → tar.gz 온더플라이 스트리밍 (서버 임시파일·메모리 누적 없음).

각 파일 본체는 스토리지 백엔드(로컬/R2)에서 스트림으로 읽어 tar에 흘려보낸다.
"""

import io
import tarfile
import time
from collections import deque
from collections.abc import Iterable, Iterator

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import Node
from .storage import StorageBackend


class _ChunkBuffer(io.RawIOBase):
    def __init__(self) -> None:
        self.chunks: deque[bytes] = deque()

    def writable(self) -> bool:  # pragma: no cover - tarfile 내부 호출
        return True

    def write(self, b) -> int:  # noqa: ANN001
        self.chunks.append(bytes(b))
        return len(b)

    def drain(self) -> Iterator[bytes]:
        while self.chunks:
            yield self.chunks.popleft()


def stream_tar_gz(
    storage: StorageBackend, entries: Iterable[tuple[Node | None, str]]
) -> Iterator[bytes]:
    """entries: (파일 노드 | None(=디렉토리), 아카이브 내 이름).

    이름은 UTF-8 NFC (PAX 포맷) — 리눅스에서 한글 파일명 보존.
    본체가 없는(삭제된 blob) 파일은 건너뛴다.
    """
    buf = _ChunkBuffer()
    now = int(time.time())
    with tarfile.open(mode="w|gz", fileobj=buf, format=tarfile.PAX_FORMAT) as tar:
        for node, arcname in entries:
            if node is None:
                info = tarfile.TarInfo(arcname.rstrip("/") + "/")
                info.type = tarfile.DIRTYPE
                info.mode = 0o755
                info.mtime = now
                tar.addfile(info)
            else:
                if not storage.exists(node.storage_key):
                    continue
                info = tarfile.TarInfo(arcname)
                info.size = node.size
                info.mode = 0o644
                info.mtime = now
                body = storage.open_stream(node.storage_key)
                try:
                    tar.addfile(info, body)
                finally:
                    body.close()
            yield from buf.drain()
    yield from buf.drain()


def _children(db: Session, node: Node) -> list[Node]:
    rows = db.scalars(
        select(Node).where(Node.parent_id == node.id, Node.deleted_at.is_(None))
    ).all()
    return sorted(rows, key=lambda n: (0 if n.type == "folder" else 1, n.name))


def _walk(db: Session, node: Node, prefix: str) -> Iterator[tuple[Node | None, str]]:
    for child in _children(db, node):
        arcname = f"{prefix}/{child.name}"
        if child.type == "folder":
            yield (None, arcname)
            yield from _walk(db, child, arcname)
        else:
            yield (child, arcname)


def collect_entries(db: Session, root: Node) -> Iterator[tuple[Node | None, str]]:
    """폴더 서브트리를 (파일 노드|None(=디렉토리), 아카이브명)으로 평탄화 — 삭제 항목 제외."""
    yield (None, root.name)
    yield from _walk(db, root, root.name)


def collect_space_entries(
    db: Session, space_name: str, roots: list[Node]
) -> Iterator[tuple[Node | None, str]]:
    """공간 전체를 평탄화 — 루트 항목들을 '공간 이름' 폴더 밑에 담는다(백업용).

    공간은 노드가 아니라서 collect_entries를 쓸 수 없다. 풀었을 때 어느 공간 것인지
    바로 보이도록 최상위 디렉토리 하나를 만들어 그 안에 넣는다.
    """
    yield (None, space_name)
    for item in sorted(roots, key=lambda n: (0 if n.type == "folder" else 1, n.name)):
        arcname = f"{space_name}/{item.name}"
        if item.type == "folder":
            yield (None, arcname)
            yield from _walk(db, item, arcname)
        else:
            yield (item, arcname)
