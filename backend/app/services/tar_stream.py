"""폴더 → tar.gz 온더플라이 스트리밍 (서버 임시파일·메모리 누적 없음)."""

import io
import tarfile
import time
from collections import deque
from collections.abc import Iterable, Iterator
from pathlib import Path


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


def stream_tar_gz(entries: Iterable[tuple[Path | None, str]]) -> Iterator[bytes]:
    """entries: (파일 경로 | None(=디렉토리), 아카이브 내 이름).

    이름은 UTF-8 NFC (PAX 포맷) — 리눅스에서 한글 파일명 보존.
    """
    buf = _ChunkBuffer()
    now = int(time.time())
    with tarfile.open(mode="w|gz", fileobj=buf, format=tarfile.PAX_FORMAT) as tar:
        for path, arcname in entries:
            if path is None:
                info = tarfile.TarInfo(arcname.rstrip("/") + "/")
                info.type = tarfile.DIRTYPE
                info.mode = 0o755
                info.mtime = now
                tar.addfile(info)
            else:
                stat = path.stat()
                info = tarfile.TarInfo(arcname)
                info.size = stat.st_size
                info.mode = 0o644
                info.mtime = int(stat.st_mtime)
                with path.open("rb") as fh:
                    tar.addfile(info, fh)
            yield from buf.drain()
    yield from buf.drain()
