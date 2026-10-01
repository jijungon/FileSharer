import io
import subprocess
from pathlib import Path

import pytest

from app.services import media
from app.services.media import TranscodeError, audio_is_browser_ok, is_video


def upload(client, url, name, content=b"x", mime="application/octet-stream"):
    return client.post(url, files={"file": (name, io.BytesIO(content), mime)})


def spaces_of(client):
    return {s["type"]: s for s in client.get("/api/spaces").json()}


def test_is_video_by_extension():
    assert is_video("clip.mp4")
    assert is_video("영상.MOV")
    assert is_video("a.mkv")
    assert not is_video("doc.pdf")
    assert not is_video("note.txt")
    assert not is_video("noext")


def test_audio_browser_ok_classification():
    # 브라우저가 그대로 재생 가능 → 재인코딩 불필요
    for ok in ("aac", "mp3", "opus", "vorbis", "flac", ""):
        assert audio_is_browser_ok(ok)
    # 브라우저 비호환 → AAC 변환 필요
    for bad in ("ac3", "eac3", "dts", "truehd", "pcm_s16le"):
        assert not audio_is_browser_ok(bad)


def test_video_preview_rejects_non_video(admin_client):
    pid = spaces_of(admin_client)["personal"]["id"]
    node = upload(
        admin_client, f"/api/spaces/{pid}/files", "문서.txt", b"hello", "text/plain"
    ).json()
    assert admin_client.get(f"/api/files/{node['id']}/preview.mp4").status_code == 400


def test_video_preview_serves_original_when_not_transcodable(admin_client):
    """ffmpeg/ffprobe가 없거나 프로브 실패(가짜 영상)여도 원본이라도 내려준다(그림은 나옴)."""
    pid = spaces_of(admin_client)["personal"]["id"]
    body = b"\x00\x00\x00\x18ftypmp42fake-video-bytes"
    node = upload(admin_client, f"/api/spaces/{pid}/files", "clip.mp4", body, "video/mp4").json()
    r = admin_client.get(f"/api/files/{node['id']}/preview.mp4")
    assert r.status_code == 200
    assert r.content == body


# ── 트랜스코더 내부 (실제 ffmpeg 없이 subprocess 모킹) ──────────────────────
#
# 이 파일은 지금까지 분류 함수와 API 경계만 봤다. 정작 ffmpeg 를 부르는 쪽
# (_sandbox_env · audio_codec · transcode_audio_to_aac)은 42% 만 덮여 있었다.
# 셋 다 **실행 실패가 조용한 쪽으로 번지는** 코드라 경계를 박아둔다.

def _completed(stdout: bytes = b"", returncode: int = 0) -> subprocess.CompletedProcess:
    return subprocess.CompletedProcess(args=[], returncode=returncode, stdout=stdout, stderr=b"")


def test_sandbox_env_scrubs_secrets(monkeypatch):
    """변환기(ffmpeg)에 앱 시크릿이 넘어가면 안 된다 — office.py 와 같은 약속.

    office 쪽엔 이 검사가 있었는데 media 쪽엔 없었다. 같은 보안 속성이면 같이 지켜야 한다.
    """
    monkeypatch.setenv("R2_SECRET_ACCESS_KEY", "supersecret")
    monkeypatch.setenv("SECRET_KEY", "app-secret")
    monkeypatch.setenv("GOOGLE_CLIENT_SECRET", "g-secret")
    monkeypatch.setenv("PATH", "/usr/bin:/bin")
    monkeypatch.setenv("LANG", "ko_KR.UTF-8")

    env = media._sandbox_env()

    for secret in ("R2_SECRET_ACCESS_KEY", "SECRET_KEY", "GOOGLE_CLIENT_SECRET"):
        assert secret not in env
    assert env["PATH"] == "/usr/bin:/bin"
    assert env["LANG"] == "ko_KR.UTF-8"


def test_sandbox_env_always_has_a_path(monkeypatch):
    """PATH 가 비어 있어도 기본값을 깔아준다 — 안 그러면 ffmpeg 를 못 찾는다."""
    monkeypatch.delenv("PATH", raising=False)
    assert media._sandbox_env()["PATH"] == "/usr/bin:/bin"


def test_audio_codec_needs_ffprobe(monkeypatch, tmp_path):
    monkeypatch.setattr(media, "ffprobe_bin", lambda: None)
    with pytest.raises(TranscodeError, match="ffprobe"):
        media.audio_codec(tmp_path / "clip.mp4")


def test_audio_codec_normalizes_output(monkeypatch, tmp_path):
    """ffprobe 출력은 줄바꿈·대문자가 섞여 온다. 비교는 소문자로 한다."""
    monkeypatch.setattr(media, "ffprobe_bin", lambda: "/usr/bin/ffprobe")
    monkeypatch.setattr(subprocess, "run", lambda *a, **k: _completed(b"AC3\n"))
    assert media.audio_codec(tmp_path / "clip.mp4") == "ac3"
    # 이 값이 '재인코딩 필요'로 이어져야 의미가 있다
    assert not media.audio_is_browser_ok(media.audio_codec(tmp_path / "clip.mp4"))


def test_audio_codec_empty_when_no_audio_track(monkeypatch, tmp_path):
    """오디오 트랙이 없으면 ffprobe 는 빈 줄을 준다 → '' → 변환 불필요로 읽혀야 한다."""
    monkeypatch.setattr(media, "ffprobe_bin", lambda: "/usr/bin/ffprobe")
    monkeypatch.setattr(subprocess, "run", lambda *a, **k: _completed(b"\n"))
    assert media.audio_codec(tmp_path / "silent.mp4") == ""
    assert media.audio_is_browser_ok("")


def test_audio_codec_timeout_and_failure(monkeypatch, tmp_path):
    monkeypatch.setattr(media, "ffprobe_bin", lambda: "/usr/bin/ffprobe")

    def timeout(*a, **k):
        raise subprocess.TimeoutExpired(cmd="ffprobe", timeout=60)

    monkeypatch.setattr(subprocess, "run", timeout)
    with pytest.raises(TranscodeError, match="시간이 초과"):
        media.audio_codec(tmp_path / "clip.mp4")

    def failed(*a, **k):
        raise subprocess.CalledProcessError(1, "ffprobe", stderr=b"moov atom not found")

    monkeypatch.setattr(subprocess, "run", failed)
    with pytest.raises(TranscodeError, match="확인 실패"):
        media.audio_codec(tmp_path / "clip.mp4")


def test_transcode_needs_ffmpeg(monkeypatch, tmp_path):
    monkeypatch.setattr(media, "ffmpeg_bin", lambda: None)
    with pytest.raises(TranscodeError, match="ffmpeg"):
        media.transcode_audio_to_aac(tmp_path / "in.mp4", tmp_path / "cache", "k")


def test_transcode_reuses_cache_without_running_ffmpeg(monkeypatch, tmp_path):
    """이미 변환해 둔 게 있으면 ffmpeg 를 아예 부르지 않는다 — 캐시가 캐시여야 한다."""
    cache = tmp_path / "cache"
    cache.mkdir()
    (cache / "key.mp4").write_bytes(b"already-converted")

    def boom(*a, **k):  # 불리면 캐시가 안 듣는 것
        raise AssertionError("캐시가 있는데 ffmpeg 를 불렀다")

    monkeypatch.setattr(media, "ffmpeg_bin", lambda: "/usr/bin/ffmpeg")
    monkeypatch.setattr(subprocess, "run", boom)

    out = media.transcode_audio_to_aac(tmp_path / "in.mp4", cache, "key")
    assert out.read_bytes() == b"already-converted"


def test_transcode_copies_video_and_reencodes_only_audio(monkeypatch, tmp_path):
    """명령줄을 박아둔다. `-c:v copy` 가 빠지면 **영상까지 재인코딩**돼 CPU 가 폭주한다.

    기능은 그대로 동작하므로 눈으로는 안 보이고, 느려진 뒤에야 안다.
    """
    seen: dict = {}

    def fake_run(cmd, **kwargs):
        seen["cmd"] = cmd
        seen["env"] = kwargs.get("env", {})
        seen["timeout"] = kwargs.get("timeout")
        Path(cmd[-1]).write_bytes(b"converted")
        return _completed()

    monkeypatch.setenv("R2_SECRET_ACCESS_KEY", "supersecret")
    monkeypatch.setattr(media, "ffmpeg_bin", lambda: "/usr/bin/ffmpeg")
    monkeypatch.setattr(subprocess, "run", fake_run)

    out = media.transcode_audio_to_aac(tmp_path / "in.mkv", tmp_path / "cache", "key")
    cmd = seen["cmd"]

    # ulimit 래퍼로 감싸 실행한다(코어덤프 금지 + CPU 상한) — office.py 와 같은 방식
    assert cmd[0] == "/bin/sh" and cmd[1] == "-c"
    assert "ulimit -c 0" in cmd[2] and "ulimit -t 900" in cmd[2]

    joined = " ".join(cmd)
    assert "-c:v copy" in joined, "영상은 그대로 복사해야 한다"
    assert "-c:a aac" in joined, "오디오만 AAC 로 재인코딩"
    assert "+faststart" in joined, "moov 를 앞으로 — 안 그러면 전부 받아야 재생된다"
    assert "0:a:0?" in joined and "0:v:0?" in joined, "첫 스트림만, 없으면 건너뜀"

    # 시크릿은 ffmpeg 환경에 없다
    assert "R2_SECRET_ACCESS_KEY" not in seen["env"]
    assert seen["timeout"] == 900

    assert out.name == "key.mp4"
    assert out.read_bytes() == b"converted"


def test_transcode_leaves_no_partial_file_on_failure(monkeypatch, tmp_path):
    """실패하면 tmp 를 치우고 **결과 파일을 만들지 않는다**.

    반쪽짜리가 cache_key 자리에 남으면 다음 요청이 그걸 '변환 완료'로 보고 내려준다.
    """
    cache = tmp_path / "cache"

    def fail(cmd, **kwargs):
        Path(cmd[-1]).write_bytes(b"half")  # 쓰다 만 상태를 흉내
        raise subprocess.CalledProcessError(1, "ffmpeg", stderr=b"Invalid data")

    monkeypatch.setattr(media, "ffmpeg_bin", lambda: "/usr/bin/ffmpeg")
    monkeypatch.setattr(subprocess, "run", fail)

    with pytest.raises(TranscodeError, match="변환에 실패"):
        media.transcode_audio_to_aac(tmp_path / "in.mp4", cache, "key")

    assert not (cache / "key.mp4").exists(), "실패했는데 결과가 남았다"
    assert list(cache.glob("*.tmp.mp4")) == [], "tmp 가 안 치워졌다"


def test_transcode_errors_when_ffmpeg_exits_clean_but_writes_nothing(monkeypatch, tmp_path):
    """종료코드 0 인데 파일이 없는 경우 — 0바이트를 '성공'으로 캐시하면 안 된다."""
    monkeypatch.setattr(media, "ffmpeg_bin", lambda: "/usr/bin/ffmpeg")
    monkeypatch.setattr(subprocess, "run", lambda *a, **k: _completed())

    with pytest.raises(TranscodeError, match="생성되지 않았"):
        media.transcode_audio_to_aac(tmp_path / "in.mp4", tmp_path / "cache", "key")


def test_transcode_timeout_cleans_up(monkeypatch, tmp_path):
    cache = tmp_path / "cache"

    def slow(cmd, **kwargs):
        Path(cmd[-1]).write_bytes(b"partial")
        raise subprocess.TimeoutExpired(cmd="ffmpeg", timeout=900)

    monkeypatch.setattr(media, "ffmpeg_bin", lambda: "/usr/bin/ffmpeg")
    monkeypatch.setattr(subprocess, "run", slow)

    with pytest.raises(TranscodeError, match="시간이 초과"):
        media.transcode_audio_to_aac(tmp_path / "in.mp4", cache, "key")
    assert list(cache.glob("*")) == []
