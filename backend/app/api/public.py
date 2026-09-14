"""비로그인 공개 라우트 /s/* — 만료 공유 링크가 유일한 비인증 접근 통로."""

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import (
    FileResponse,
    PlainTextResponse,
    RedirectResponse,
    StreamingResponse,
)
from sqlalchemy.orm import Session

from ..deps import get_db
from ..services import audit
from ..services.serving import content_disposition as _content_disposition
from ..services.serving import serve_blob
from ..services.shares import check_password, consume_download, resolve_share
from ..services.storage import StorageBackend
from ..services.tar_stream import stream_tar_gz
from .nodes import collect_tar_entries, get_storage

router = APIRouter(tags=["public"])


@router.get("/s/{token}")
def share_landing(token: str, request: Request, db: Session = Depends(get_db)):
    """콘텐츠 협상: 브라우저(text/html)는 공유 페이지(SPA), CLI는 다운로드로 302."""
    resolve_share(db, token)  # 유효성만 확인 (비밀번호는 콘텐츠 접근 시)
    accept = request.headers.get("accept", "")
    if "text/html" in accept:
        from ..main import STATIC_DIR

        index = STATIC_DIR / "index.html"
        if index.is_file():
            return FileResponse(index)
        return {"hint": "dev mode: open the Vite dev server share page"}
    return RedirectResponse(f"/s/{token}/download", status_code=302)


@router.get("/s/{token}/meta")
def share_meta(token: str, db: Session = Depends(get_db)) -> dict:
    share, node = resolve_share(db, token)
    return {
        "name": node.name,
        "type": node.type,
        "size": node.size,
        "mime": node.mime,
        "protected": share.password_hash is not None,
        "expires_at": share.expires_at.isoformat(),
    }


@router.get("/s/{token}/raw")
def share_raw(
    token: str,
    request: Request,
    db: Session = Depends(get_db),
    storage: StorageBackend = Depends(get_storage),
):
    """공유 페이지의 미리보기용 (다운로드 카운트 미증가)."""
    share, node = resolve_share(db, token)
    check_password(request, share)
    if node.type != "file":
        raise HTTPException(status_code=400, detail="파일이 아닙니다")
    return serve_blob(
        storage,
        node.storage_key,
        filename=node.name,
        media_type=node.mime or "application/octet-stream",
        disposition="inline",
        request=request,
    )


@router.get("/s/{token}/download")
def share_download(
    token: str,
    request: Request,
    db: Session = Depends(get_db),
    storage: StorageBackend = Depends(get_storage),
):
    share, node = resolve_share(db, token)
    check_password(request, share)
    if node.type == "folder":
        return RedirectResponse(f"/s/{token}/tar", status_code=302)
    if not storage.exists(node.storage_key):
        raise HTTPException(status_code=410, detail="파일 본체가 없습니다")
    consume_download(db, share, request)
    audit.log(db, "share_download", node_id=node.id, detail=node.name)
    return serve_blob(
        storage,
        node.storage_key,
        filename=node.name,
        media_type=node.mime or "application/octet-stream",
        disposition="attachment",
        request=request,
        extra_headers={"X-Checksum-SHA256": node.sha256 or storage.sha256(node.storage_key)},
    )


@router.get("/s/{token}/tar")
def share_tar(
    token: str,
    request: Request,
    db: Session = Depends(get_db),
    storage: StorageBackend = Depends(get_storage),
):
    share, node = resolve_share(db, token)
    check_password(request, share)
    if node.type != "folder":
        raise HTTPException(status_code=400, detail="폴더가 아닙니다")
    consume_download(db, share, request)
    audit.log(db, "share_download", node_id=node.id, detail=f"{node.name} (tar)")
    entries = list(collect_tar_entries(db, node))
    return StreamingResponse(
        stream_tar_gz(storage, entries),
        media_type="application/gzip",
        headers={"Content-Disposition": _content_disposition("attachment", f"{node.name}.tar.gz")},
    )

_TEMPLATE_PATH = __file__.rsplit("/api/", 1)[0] + "/assets/get.sh.tmpl"


def _sh_escape(value: str) -> str:
    """sh 더블쿼트 문자열 안에 안전하게 넣기 위한 이스케이프."""
    out = value.replace("\\", "\\\\").replace('"', '\\"').replace("$", "\\$")
    return out.replace("`", "\\`")


@router.get("/s/{token}/get")
def share_get_script(
    token: str,
    request: Request,
    db: Session = Depends(get_db),
    storage: StorageBackend = Depends(get_storage),
) -> PlainTextResponse:
    """원커맨드 POSIX sh 스크립트 — 파일/폴더 자동 판별, 다운로드+해제+체크섬."""
    share, node = resolve_share(db, token)
    from ..config import get_settings

    base = get_settings().base_url.rstrip("/")
    # 요청이 들어온 호스트를 우선 사용 (프록시 뒤에서도 올바른 절대 URL)
    origin = str(request.base_url).rstrip("/")
    if origin and not origin.startswith("http://testserver"):
        base = origin

    sha = ""
    if node.type == "file" and storage.exists(node.storage_key):
        sha = node.sha256 or storage.sha256(node.storage_key)

    with open(_TEMPLATE_PATH, encoding="utf-8") as fh:
        script = fh.read()
    name = node.name if node.type == "file" else node.name
    script = (
        script.replace("__BASE__", _sh_escape(base))
        .replace("__TOKEN__", _sh_escape(token))
        .replace("__TYPE__", node.type)
        .replace("__NAME__", _sh_escape(name))
        .replace("__SHA256__", sha)
        .replace("__PROTECTED__", "1" if share.password_hash is not None else "0")
    )
    return PlainTextResponse(script, media_type="text/x-sh; charset=utf-8")
