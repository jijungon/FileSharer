"""영상 오디오 트랜스코딩 — 브라우저가 못 푸는 오디오 코덱을 AAC로 바꿔 소리가 나게.

브라우저는 오디오로 사실상 AAC/Opus/MP3/Vorbis/FLAC만 재생한다. 방송·기관 영상에
흔한 AC-3/E-AC-3/DTS 등이 들어있으면 그림만 나오고 무음이 된다(Chrome 121+는 AC-3
지원을 뺌). 그런 경우 ffmpeg로 **오디오만** AAC로 재인코딩(영상 스트림은 그대로 copy)해
소리가 나게 한다. 결과는 cache_key(보통 storage_key)로 캐시 — 오피스→PDF 변환과 동일한
on-demand 캐시 패턴.
"""

import os
import shutil
import subprocess
from pathlib import Path

# 트랜스코더에 넘길 최소 환경변수만(앱 시크릿 R2_*/SECRET_KEY 노출 방지).
_ENV_ALLOW = ("PATH", "LANG", "LANGUAGE", "LC_ALL", "LC_CTYPE", "TZ")

VIDEO_EXTS = {
    ".mp4",
    ".m4v",
    ".mov",
    ".webm",
    ".ogv",
    ".mkv",
    ".avi",
    ".mpg",
    ".mpeg",
    ".wmv",
    ".flv",
    ".3gp",
    ".ts",
}

# 브라우저가 재생 가능한 오디오 코덱(이거면 재인코딩 불필요). ""=오디오 트랙 없음.
BROWSER_AUDIO_CODECS = {"aac", "mp3", "opus", "vorbis", "flac", ""}

# 자식(ffmpeg)에 걸 자원 상한: 코어덤프 금지 + CPU 시간 상한. preexec_fn은 멀티스레드에서
# 위험하므로 sh의 ulimit로 exec 직전에 건다(office.py와 동일 방식).
_ULIMIT_PREAMBLE = 'ulimit -c 0; ulimit -t 900; exec "$@"'


class TranscodeError(RuntimeError):
    """ffmpeg/ffprobe 미설치·변환 실패·시간 초과 등."""


def ext_of(name: str) -> str:
    dot = name.rfind(".")
    return name[dot:].lower() if dot != -1 else ""


def is_video(name: str) -> bool:
    return ext_of(name) in VIDEO_EXTS


def audio_is_browser_ok(codec: str) -> bool:
    """오디오 코덱이 브라우저에서 그대로 재생 가능한지(재인코딩 불필요한지)."""
    return codec in BROWSER_AUDIO_CODECS


def ffmpeg_bin() -> str | None:
    return shutil.which("ffmpeg")


def ffprobe_bin() -> str | None:
    return shutil.which("ffprobe")


def _sandbox_env() -> dict[str, str]:
    env = {k: os.environ[k] for k in _ENV_ALLOW if k in os.environ}
    env.setdefault("PATH", "/usr/bin:/bin")
    return env


def audio_codec(src: Path) -> str:
    """첫 오디오 스트림의 코덱명(소문자). 오디오 트랙이 없으면 ''."""
    probe = ffprobe_bin()
    if not probe:
        raise TranscodeError("ffprobe가 설치돼 있지 않습니다")
    try:
        out = subprocess.run(
            [
                probe,
                "-v",
                "error",
                "-select_streams",
                "a:0",
                "-show_entries",
                "stream=codec_name",
                "-of",
                "default=nk=1:nw=1",
                str(src),
            ],
            check=True,
            capture_output=True,
            timeout=60,
            env=_sandbox_env(),
        )
    except subprocess.TimeoutExpired as exc:
        raise TranscodeError("오디오 코덱 확인 시간이 초과됐습니다") from exc
    except subprocess.CalledProcessError as exc:
        detail = exc.stderr.decode("utf-8", "ignore")[:200] if exc.stderr else ""
        raise TranscodeError(f"오디오 코덱 확인 실패: {detail}") from exc
    return out.stdout.decode("utf-8", "ignore").strip().lower()


def transcode_audio_to_aac(src: Path, cache_dir: Path, cache_key: str) -> Path:
    """영상 스트림은 그대로 두고 오디오만 AAC로 재인코딩한 mp4를 만들어 경로를 돌려준다.

    cache_dir/<cache_key>.mp4 가 이미 있으면 재사용. 실패하면 TranscodeError.
    """
    out = cache_dir / f"{cache_key}.mp4"
    if out.is_file():
        return out

    binary = ffmpeg_bin()
    if not binary:
        raise TranscodeError("ffmpeg가 설치돼 있지 않습니다")

    cache_dir.mkdir(parents=True, exist_ok=True)
    tmp = cache_dir / f"{cache_key}.tmp.mp4"
    ff_cmd = [
        binary,
        "-y",
        "-i",
        str(src),
        "-map",
        "0:v:0?",  # 첫 영상 스트림만(있으면)
        "-map",
        "0:a:0?",  # 첫 오디오 스트림만(있으면)
        "-c:v",
        "copy",  # 영상은 재인코딩 없이 그대로(빠름)
        "-c:a",
        "aac",
        "-b:a",
        "192k",
        "-movflags",
        "+faststart",  # moov를 앞으로 → 웹 스트리밍 최적화
        str(tmp),
    ]
    try:
        subprocess.run(
            ["/bin/sh", "-c", _ULIMIT_PREAMBLE, "sh", *ff_cmd],
            check=True,
            capture_output=True,
            timeout=900,
            env=_sandbox_env(),
        )
    except subprocess.TimeoutExpired as exc:
        tmp.unlink(missing_ok=True)
        raise TranscodeError("변환 시간이 초과됐습니다") from exc
    except subprocess.CalledProcessError as exc:
        tmp.unlink(missing_ok=True)
        detail = exc.stderr.decode("utf-8", "ignore")[-300:] if exc.stderr else ""
        raise TranscodeError(f"영상 변환에 실패했습니다: {detail}") from exc

    if not tmp.is_file():
        raise TranscodeError("변환 결과가 생성되지 않았습니다")
    tmp.replace(out)
    return out
