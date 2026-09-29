"""폴더·선택항목 → tar.gz 온더플라이 스트리밍.

**진짜로 흘려보낸다.** 만드는 쪽(스토리지에서 읽어 압축)과 보내는 쪽(클라이언트)을
유계 큐로 잇고, 큐가 차면 만드는 쪽이 멈춘다. 그래서

  · 서버 메모리는 큐 크기로 **상한이 잡힌다** — 500MB 파일이어도 몇백 KB만 쓴다.
  · 첫 바이트가 **곧바로** 나간다 — 파일 하나를 다 읽을 때까지 기다리지 않는다.
  · 스토리지에서 읽는 동안 앞서 만든 것이 동시에 전송된다(겹친다).

예전에는 파일 하나를 통째로 버퍼에 쌓고 다 끝난 뒤에야 내보냈다. 40MB 파일이면
40MB가 메모리에 앉아 있었고, 그동안 클라이언트는 아무것도 못 받았다.
"""

import io
import logging
import queue
import tarfile
import threading
import time
from collections.abc import Iterable, Iterator
from concurrent.futures import Future, ThreadPoolExecutor

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import Node
from .storage import StorageBackend

logger = logging.getLogger("filesharer")

# 앞서 만들어 둘 덩어리 수. 이것이 곧 서버 메모리 상한이다(덩어리는 tarfile 이 정하는
# ~10KB 단위라 수백 KB 수준). 너무 작으면 전송이 끊기고, 크면 메모리를 그만큼 쓴다.
QUEUE_CHUNKS = 64
# 9는 이미 압축된 파일(pptx·png·zip)에 CPU만 태우고 크기는 그대로다. 6이면 결과가
# 사실상 같으면서 더 빠르다(측정: 같은 크기, 1.3배).
COMPRESS_LEVEL = 6
# 미리 열어 둘 파일 수. 원격 저장소는 '여는 것' 자체가 왕복 한 번이라, 앞 파일을 보내는
# 동안 다음 것을 열어두면 그 왕복이 통째로 숨는다. 작은 파일이 많을수록 효과가 크다
# (측정: 300KB 20개에서 여는 지연 2.40초 → 0.12초).
# 크게 잡을 이유는 없다 — 그만큼 R2 연결을 동시에 붙들고 있게 된다.
PREFETCH = 3
_DONE = object()


class _Aborted(Exception):
    """받는 쪽이 사라졌다 — 만들던 것을 접는다."""


class _QueueSink(io.RawIOBase):
    """tarfile 이 쓰는 대로 큐에 넘긴다. 큐가 차면 **여기서 막히는 것**이 핵심이다 —
    클라이언트가 받아가는 만큼만 만들게 된다."""

    def __init__(self, q: queue.Queue, stop: threading.Event) -> None:
        self.q = q
        self.stop = stop

    def writable(self) -> bool:  # pragma: no cover - tarfile 내부 호출
        return True

    def write(self, b) -> int:  # noqa: ANN001
        data = bytes(b)
        if not data:
            return 0
        while True:
            if self.stop.is_set():
                raise _Aborted
            try:
                self.q.put(data, timeout=0.5)
                return len(data)
            except queue.Full:
                continue  # 다시 stop 을 확인하고 재시도


def _plain(entries: Iterable[tuple[Node | None, str]]) -> list[tuple[str | None, str, int]]:
    """(노드, 이름) → (storage_key|None, 이름, 크기).

    ORM 객체를 다른 스레드로 넘기지 않는다. 세션은 스레드 안전하지 않고, 만료된
    속성을 건드리면 그 스레드에서 DB를 다시 읽는다. 여기서(호출자 스레드에서) 끝낸다.
    """
    out: list[tuple[str | None, str, int]] = []
    for node, arcname in entries:
        if node is None:
            out.append((None, arcname, 0))
        else:
            out.append((node.storage_key, arcname, node.size))
    return out


def _open_ahead(
    storage: StorageBackend,
    plan: list[tuple[str | None, str, int]],
    pool: ThreadPoolExecutor,
) -> Iterator[tuple[str, int, Future | None]]:
    """plan 을 돌되 파일은 **PREFETCH 개 앞서서 열어 둔다**.

    yield: (아카이브명, 크기, future|None). future 가 None 이면 디렉토리다.
    여는 일(원격이면 왕복 한 번)이 앞 파일을 보내는 동안 끝나 있게 만드는 게 전부다.
    """
    files = [i for i, (key, _, _) in enumerate(plan) if key is not None]
    futures: dict[int, Future] = {}
    submitted = 0

    def fill(done: int) -> None:
        nonlocal submitted
        while submitted < len(files) and submitted < done + PREFETCH:
            idx = files[submitted]
            futures[idx] = pool.submit(storage.open_stream, plan[idx][0])
            submitted += 1

    consumed = 0
    fill(consumed)
    for i, (key, arcname, size) in enumerate(plan):
        if key is None:
            yield arcname, size, None
            continue
        fut = futures.pop(i)
        yield arcname, size, fut
        consumed += 1
        fill(consumed)  # 하나 쓸 때마다 하나 더 앞서 연다


def stream_tar_gz(
    storage: StorageBackend, entries: Iterable[tuple[Node | None, str]]
) -> Iterator[bytes]:
    """entries: (파일 노드 | None(=디렉토리), 아카이브 내 이름).

    이름은 UTF-8 NFC (PAX 포맷) — 리눅스에서 한글 파일명 보존.
    본체를 못 읽는 파일은 **헤더를 쓰기 전에** 건너뛴다(쓰고 나서 실패하면 tar가 깨진다).
    """
    plan = _plain(entries)
    q: queue.Queue = queue.Queue(maxsize=QUEUE_CHUNKS)
    stop = threading.Event()

    def produce() -> None:
        pool = ThreadPoolExecutor(max_workers=PREFETCH, thread_name_prefix="tar-open")
        try:
            sink = _QueueSink(q, stop)
            now = int(time.time())
            with tarfile.open(
                mode="w|gz",
                fileobj=sink,
                format=tarfile.PAX_FORMAT,
                compresslevel=COMPRESS_LEVEL,
            ) as tar:
                for arcname, size, fut in _open_ahead(storage, plan, pool):
                    if fut is None:
                        info = tarfile.TarInfo(arcname.rstrip("/") + "/")
                        info.type = tarfile.DIRTYPE
                        info.mode = 0o755
                        info.mtime = now
                        tar.addfile(info)
                        continue
                    # 예전엔 exists() 로 먼저 물어봤다 — 원격 저장소에선 그게 파일마다
                    # 왕복 한 번이다. 어차피 열어봐야 아는 것이라 열면서 확인한다.
                    try:
                        body = fut.result()
                    except Exception:
                        logger.warning("본체를 못 읽어 건너뛴다: %s", arcname)
                        continue
                    try:
                        info = tarfile.TarInfo(arcname)
                        info.size = size
                        info.mode = 0o644
                        info.mtime = now
                        tar.addfile(info, body)
                    finally:
                        body.close()
        except _Aborted:
            pass  # 받는 쪽이 끊었다 — 정상 종료
        except BaseException as err:  # noqa: BLE001 - 소비자에게 그대로 전달한다
            try:
                q.put(err, timeout=1)
            except queue.Full:
                pass
        finally:
            # 미리 열어뒀다가 못 쓴 스트림을 닫는다(중간에 끊겼을 때).
            pool.shutdown(wait=False, cancel_futures=True)
            try:
                q.put(_DONE, timeout=1)
            except queue.Full:
                pass

    worker = threading.Thread(target=produce, name="tar-gz", daemon=True)
    worker.start()
    try:
        while True:
            item = q.get()
            if item is _DONE:
                return
            if isinstance(item, BaseException):
                raise item
            yield item
    finally:
        # 소비자가 중간에 그만뒀을 때(클라이언트 끊김) 만들던 스레드를 풀어준다.
        # 안 하면 put 에서 영영 막혀 스레드가 쌓인다.
        stop.set()
        while worker.is_alive():
            try:
                q.get_nowait()
            except queue.Empty:
                worker.join(timeout=0.5)
                break


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
