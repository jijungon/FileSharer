"""폴더 → tar.gz 온더플라이 스트리밍 (서버 임시파일·메모리 누적 없음).

각 파일 본체는 스토리지 백엔드(로컬/R2)에서 스트림으로 읽어 tar에 흘려보낸다.
"""

import io
import tarfile
import time
from collections import deque
from collections.abc import Iterable, Iterator

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
