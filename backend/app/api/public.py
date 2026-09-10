"""비로그인 공개 라우트 /s/* — 만료 공유 링크가 유일한 비인증 접근 통로."""

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import FileResponse, RedirectResponse, StreamingResponse
from sqlalchemy.orm import Session

from ..deps import get_db
from ..services import audit
from ..services.shares import check_password, consume_download, resolve_share
from ..services.storage import LocalStorage
from ..services.tar_stream import stream_tar_gz
from .nodes import _content_disposition, collect_tar_entries, get_storage

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
    storage: LocalStorage = Depends(get_storage),
):
    """공유 페이지의 미리보기용 (다운로드 카운트 미증가)."""
    share, node = resolve_share(db, token)
    check_password(request, share)
    if node.type != "file":
        raise HTTPException(status_code=400, detail="파일이 아닙니다")
    path = storage.path_for(node.storage_key)
    if not path.is_file():
        raise HTTPException(status_code=410, detail="파일 본체가 없습니다")
    return FileResponse(
        path,
        media_type=node.mime or "application/octet-stream",
        headers={"Content-Disposition": _content_disposition("inline", node.name)},
    )


@router.get("/s/{token}/download")
def share_download(
    token: str,
    request: Request,
    db: Session = Depends(get_db),
    storage: LocalStorage = Depends(get_storage),
):
    share, node = resolve_share(db, token)
    check_password(request, share)
    if node.type == "folder":
        return RedirectResponse(f"/s/{token}/tar", status_code=302)
    path = storage.path_for(node.storage_key)
    if not path.is_file():
        raise HTTPException(status_code=410, detail="파일 본체가 없습니다")
    consume_download(db, share)
    audit.log(db, "share_download", node_id=node.id, detail=node.name)
    return FileResponse(
        path,
        media_type=node.mime or "application/octet-stream",
        headers={
            "Content-Disposition": _content_disposition("attachment", node.name),
            "X-Checksum-SHA256": storage.sha256(node.storage_key),
        },
    )


@router.get("/s/{token}/tar")
def share_tar(
    token: str,
    request: Request,
    db: Session = Depends(get_db),
    storage: LocalStorage = Depends(get_storage),
):
    share, node = resolve_share(db, token)
    check_password(request, share)
    if node.type != "folder":
        raise HTTPException(status_code=400, detail="폴더가 아닙니다")
    consume_download(db, share)
    audit.log(db, "share_download", node_id=node.id, detail=f"{node.name} (tar)")
    entries = list(collect_tar_entries(db, storage, node))
    return StreamingResponse(
        stream_tar_gz(entries),
        media_type="application/gzip",
        headers={"Content-Disposition": _content_disposition("attachment", f"{node.name}.tar.gz")},
    )
