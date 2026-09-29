"""tar.gz 스트리밍이 '진짜로 흘려보내는지'.

여기서 고정하는 건 결과물(내용)이 아니라 **흐름**이다. 내용은 test_files.py 가 본다.
예전 구현은 파일 하나를 통째로 메모리에 쌓고 다 끝난 뒤에야 내보냈고, 파일마다
exists() 로 저장소에 한 번 더 물어봤다. 둘 다 사용자가 기다리는 시간이었다.
"""

import io
import os
import tarfile
import threading
import time

from app.services.tar_stream import QUEUE_CHUNKS, stream_tar_gz


class Counting(io.BytesIO):
    """읽힌 만큼 기록하는 스트림."""

    def __init__(self, data: bytes) -> None:
        super().__init__(data)
        self.read_bytes = 0

    def read(self, n: int = -1) -> bytes:  # type: ignore[override]
        out = super().read(n)
        self.read_bytes += len(out)
        return out


class Stub:
    """저장소 대역. exists() 를 부르면 **실패시킨다** — 부를 이유가 없어야 한다."""

    def __init__(self, blobs: dict[str, bytes], fail: set[str] | None = None) -> None:
        self.blobs = blobs
        self.fail = fail or set()
        self.opened: list[str] = []
        self.streams: dict[str, Counting] = {}

    def exists(self, key: str) -> bool:
        raise AssertionError("exists() 는 부르지 않아야 한다 — 원격에선 왕복 한 번이다")

    def open_stream(self, key: str) -> Counting:
        if key in self.fail:
            raise FileNotFoundError(key)
        self.opened.append(key)
        s = Counting(self.blobs[key])
        self.streams[key] = s
        return s


class N:
    def __init__(self, key: str, size: int) -> None:
        self.storage_key, self.size = key, size


def test_first_bytes_arrive_before_the_file_is_fully_read():
    """핵심. 파일을 다 읽을 때까지 기다리지 않는다.

    예전엔 20MB 파일이면 20MB를 전부 읽어 메모리에 쌓은 **뒤에야** 첫 바이트가 나갔다.
    사용자에겐 그게 그냥 '멈춰 있는 시간'이다.
    """
    data = os.urandom(20_000_000)  # 무작위 = 압축이 안 되므로 크기가 그대로다
    st = Stub({"k": data})
    gen = stream_tar_gz(st, [(N("k", len(data)), "큰파일.bin")])
    try:
        first = next(gen)
        assert first, "첫 덩어리가 나와야 한다"
        read_so_far = st.streams["k"].read_bytes
        assert read_so_far < len(data) / 2, (
            f"첫 바이트가 나올 때까지 {read_so_far}바이트를 읽었다 — 통째로 쌓고 있다"
        )
    finally:
        gen.close()


def test_storage_is_asked_once_per_file():
    """파일당 왕복 한 번. exists() 를 부르면 Stub 이 실패시킨다."""
    blobs = {f"k{i}": os.urandom(1000) for i in range(4)}
    st = Stub(blobs)
    entries = [(None, "공간")] + [
        (N(k, len(v)), f"공간/f{i}") for i, (k, v) in enumerate(blobs.items())
    ]
    body = b"".join(stream_tar_gz(st, entries))

    assert st.opened == list(blobs)  # 정확히 파일 수만큼, 순서대로
    with tarfile.open(fileobj=io.BytesIO(body), mode="r:gz") as tar:
        assert sorted(tar.getnames()) == ["공간", "공간/f0", "공간/f1", "공간/f2", "공간/f3"]


def test_unreadable_file_is_skipped_without_corrupting_the_archive():
    """본체를 못 여는 파일은 **헤더를 쓰기 전에** 건너뛴다.

    헤더를 쓰고 나서 실패하면 tar 가 깨져 나머지까지 못 푼다.
    """
    blobs = {"ok1": b"A" * 100, "gone": b"", "ok2": b"B" * 100}
    st = Stub(blobs, fail={"gone"})
    entries = [
        (N("ok1", 100), "가.bin"),
        (N("gone", 100), "사라진것.bin"),
        (N("ok2", 100), "나.bin"),
    ]
    body = b"".join(stream_tar_gz(st, entries))

    with tarfile.open(fileobj=io.BytesIO(body), mode="r:gz") as tar:
        assert sorted(tar.getnames()) == ["가.bin", "나.bin"]
        member = tar.extractfile("나.bin")
        assert member is not None and member.read() == b"B" * 100


def test_memory_stays_bounded_when_the_client_stalls():
    """받는 쪽이 멈추면 만드는 쪽도 멈춘다 — 그게 메모리 상한이다."""
    data = os.urandom(30_000_000)
    st = Stub({"k": data})
    gen = stream_tar_gz(st, [(N("k", len(data)), "큰파일.bin")])
    try:
        next(gen)
        time.sleep(0.5)  # 클라이언트가 잠깐 멈춘 척
        read_so_far = st.streams["k"].read_bytes
        # 큐가 차면 producer 가 막힌다. 여유를 크게 잡아도 전체의 일부여야 한다.
        assert read_so_far < 5_000_000, f"{read_so_far}바이트나 앞서 읽었다 — 상한이 없다"
    finally:
        gen.close()


def test_generator_close_releases_the_worker_thread():
    """클라이언트가 끊으면 만들던 스레드도 접힌다 — 안 그러면 스레드가 쌓인다."""
    st = Stub({"k": os.urandom(30_000_000)})
    gen = stream_tar_gz(st, [(N("k", 30_000_000), "큰파일.bin")])
    next(gen)
    assert any(t.name == "tar-gz" for t in threading.enumerate())

    gen.close()

    for _ in range(40):  # 최대 2초 기다린다
        if not any(t.name == "tar-gz" for t in threading.enumerate()):
            break
        time.sleep(0.05)
    assert not any(t.name == "tar-gz" for t in threading.enumerate()), "스레드가 남았다"


def test_queue_bound_is_a_real_number():
    """상한이 '무제한'으로 슬쩍 바뀌면 위 테스트들이 무의미해진다."""
    assert 1 <= QUEUE_CHUNKS <= 1024
