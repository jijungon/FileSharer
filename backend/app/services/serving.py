"""blob 서빙 — 스토리지 백엔드(로컬/R2)와 무관하게 파일 응답을 만든다.

로컬이면 FileResponse(Range·Content-Length 자동), 원격이면 Range를 직접 처리하는
스트리밍 응답을 돌려준다. 라우터는 이 헬퍼만 쓰고 로컬 경로에 의존하지 않는다.
"""

import re
import urllib.parse

from fastapi import HTTPException, Request
from fastapi.responses import FileResponse, Response, StreamingResponse

from .storage import CHUNK, StorageBackend

_RANGE_RE = re.compile(r"bytes=(\d+)-(\d*)")


def content_disposition(kind: str, filename: str) -> str:
    quoted = urllib.parse.quote(filename)
    return f"{kind}; filename*=UTF-8''{quoted}"


def serve_blob(
    storage: StorageBackend,
    key: str,
    *,
    filename: str,
    media_type: str,
    disposition: str = "inline",
    request: Request | None = None,
    extra_headers: dict[str, str] | None = None,
) -> Response:
    """blob을 파일 응답으로. 없으면 410."""
    if not storage.exists(key):
        raise HTTPException(status_code=410, detail="파일 본체가 없습니다")
    headers = {"Content-Disposition": content_disposition(disposition, filename)}
    if extra_headers:
        headers.update(extra_headers)
    local = storage.local_path(key)
    if local is not None:
        return FileResponse(local, media_type=media_type, headers=headers)
    return _stream(storage, key, media_type, headers, request)


def _stream(
    storage: StorageBackend,
    key: str,
    media_type: str,
    headers: dict[str, str],
    request: Request | None,
) -> StreamingResponse:
    total = storage.size(key)
    start, end = 0, total - 1
    status = 200
    range_header = request.headers.get("range") if request is not None else None
    if range_header:
        match = _RANGE_RE.match(range_header)
        if match:
            start = int(match.group(1))
            end = min(int(match.group(2)), total - 1) if match.group(2) else total - 1
            if start > end or start >= total:
                raise HTTPException(status_code=416, detail="range not satisfiable")
            status = 206
            headers["Content-Range"] = f"bytes {start}-{end}/{total}"
    length = end - start + 1
    headers["Content-Length"] = str(length)
    headers.setdefault("Accept-Ranges", "bytes")

    def body():
        remaining = length
        stream = storage.open_range(key, start, length)
        try:
            while remaining > 0:
                chunk = stream.read(min(CHUNK, remaining))
                if not chunk:
                    break
                remaining -= len(chunk)
                yield chunk
        finally:
            stream.close()

    return StreamingResponse(body(), status_code=status, media_type=media_type, headers=headers)
