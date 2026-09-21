"""업로드된 아카이브(tar/tar.gz/zip)를 서버에서 안전하게 푼다 — 순수 파싱 + 안전성만.

DB/스토리지는 건드리지 않고, '일반 파일' 항목을 (안전한 상대경로, 내용 스트림)으로
하나씩 내놓는다. 막는 것:
  * 경로 탈출: '..' 또는 절대경로 → 422 (통째로 거부)
  * 심볼릭/하드링크·디렉터리·특수 항목 → 조용히 건너뜀(일반 파일만 푼다)
  * 항목 수 폭탄 → 상한 초과 시 422
파일당·총 용량 상한은 호출부가 스토리지 스트림(max_upload_mb)으로 강제한다.
"""

import tarfile
import zipfile
from collections.abc import Iterator
from typing import BinaryIO

from fastapi import HTTPException

_MAX_FILES = 5000
_ZIP_JUNK = ("__MACOSX/",)
_TOO_MANY = f"아카이브 항목이 너무 많습니다(최대 {_MAX_FILES})"


def _safe_relpath(name: str) -> str | None:
    """아카이브 항목명 → 안전한 상대경로. '..' 성분이 있으면 None(거부 신호)."""
    parts: list[str] = []
    for seg in name.replace("\\", "/").split("/"):
        if seg == "..":
            return None
        if seg in ("", "."):
            continue
        parts.append(seg)
    return "/".join(parts) or None


def _checked_rel(src: str) -> str:
    rel = _safe_relpath(src)
    if rel is None:
        raise HTTPException(status_code=422, detail=f"안전하지 않은 경로가 있습니다: {src}")
    return rel


def _is_junk(rel: str) -> bool:
    """macOS 아카이브가 끼워 넣는 메타데이터(AppleDouble ._* , __MACOSX/)는 건너뛴다."""
    parts = rel.split("/")
    return "__MACOSX" in parts or parts[-1].startswith("._")


def iter_archive_files(fileobj: BinaryIO, kind: str) -> Iterator[tuple[str, BinaryIO]]:
    """아카이브에서 '일반 파일'만 (안전한 상대경로, 내용 스트림)으로 하나씩 yield.

    kind: tar/tar.gz/tgz → tar(압축 자동 감지) · zip → zip.
    """
    k = kind.lower()
    n = 0
    if k in ("tar", "tar.gz", "targz", "tgz", "gz", "gzip"):
        with tarfile.open(fileobj=fileobj, mode="r:*") as tf:
            for m in tf:
                if not m.isfile():  # 디렉터리·심볼릭·하드링크·특수파일 제외
                    continue
                rel = _checked_rel(m.name)
                if _is_junk(rel):
                    continue
                n += 1
                if n > _MAX_FILES:
                    raise HTTPException(status_code=422, detail=_TOO_MANY)
                ex = tf.extractfile(m)
                if ex is not None:
                    yield rel, ex
    elif k == "zip":
        with zipfile.ZipFile(fileobj) as zf:
            for info in zf.infolist():
                if info.is_dir() or info.filename.startswith(_ZIP_JUNK):
                    continue
                if (info.external_attr >> 16) & 0o170000 == 0o120000:  # 심볼릭 링크
                    continue
                rel = _checked_rel(info.filename)
                if _is_junk(rel):
                    continue
                n += 1
                if n > _MAX_FILES:
                    raise HTTPException(status_code=422, detail=_TOO_MANY)
                with zf.open(info) as ex:
                    yield rel, ex
    else:
        raise HTTPException(status_code=422, detail=f"지원하지 않는 압축 형식입니다: {kind}")
