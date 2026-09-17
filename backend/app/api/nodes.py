import mimetypes
import unicodedata
from datetime import timedelta
from pathlib import Path, PurePosixPath

from fastapi import APIRouter, Depends, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import get_settings
from ..deps import current_user, get_db
from ..models import Favorite, Node, NodeView, Space, User, email_nickname, utcnow
from ..services import audit, locks
from ..services.media import (
    TranscodeError,
    audio_codec,
    audio_is_browser_ok,
    is_video,
    transcode_audio_to_aac,
)
from ..services.office import OfficeConvertError, convert_to_pdf, is_office
from ..services.permissions import (
    can_access_space,
    get_node_checked,
    get_space_checked,
    is_descendant,
)
from ..services.serving import content_disposition as _content_disposition
from ..services.serving import serve_blob
from ..services.storage import (
    FileTooLargeError,
    StorageBackend,
    build_storage,
)
from ..services.tar_stream import stream_tar_gz
from ..services.trash import purge_subtree

router = APIRouter(prefix="/api", tags=["files"])

# mimetypes가 기본으로 모르는 웹 재생 형식 보강 (영상·음성 미리보기)
_EXTRA_MIME = {
    ".webm": "video/webm",
    ".m4v": "video/mp4",
    ".mkv": "video/x-matroska",
    ".ogv": "video/ogg",
    ".m4a": "audio/mp4",
    ".oga": "audio/ogg",
    ".weba": "audio/webm",
    ".flac": "audio/flac",
    ".md": "text/markdown",
}


def media_type_for(node: Node) -> str:
    """미리보기용 실제 Content-Type. 저장된 mime이 비었거나 일반적(octet-stream)이면
    파일 확장자로 다시 추론해 영상·음성·HTML 등이 제대로 렌더되게 한다."""
    mime = (node.mime or "").strip().lower()
    if mime and mime != "application/octet-stream":
        return mime
    dot = node.name.rfind(".")
    ext = node.name[dot:].lower() if dot != -1 else ""
    return _EXTRA_MIME.get(ext) or mimetypes.guess_type(node.name)[0] or "application/octet-stream"


def get_storage() -> StorageBackend:
    return build_storage(get_settings())


def clean_name(raw: str) -> str:
    """NFC 정규화 + 경로 성분 제거 (path traversal 차단)."""
    name = unicodedata.normalize("NFC", raw or "").strip()
    name = PurePosixPath(name.replace("\\", "/")).name
    if name in ("", ".", ".."):
        raise HTTPException(status_code=422, detail="올바르지 않은 이름입니다")
    return name[:255]


def unique_name(db: Session, space_id: str, parent_id: str | None, name: str) -> str:
    """같은 폴더에 같은 이름이 있으면 '이름 (2)'식으로 회피."""
    def taken(candidate: str) -> bool:
        return (
            db.scalar(
                select(Node).where(
                    Node.space_id == space_id,
                    Node.parent_id == parent_id,
                    Node.name == candidate,
                    Node.deleted_at.is_(None),
                )
            )
            is not None
        )

    if not taken(name):
        return name
    stem, dot, ext = name.partition(".")
    if dot and stem:
        base, suffix = stem, f".{ext}"
    else:
        base, suffix = name, ""
    for i in range(2, 1000):
        candidate = f"{base} ({i}){suffix}"
        if not taken(candidate):
            return candidate
    raise HTTPException(status_code=409, detail="같은 이름이 너무 많습니다")


def _stamp(dt) -> str | None:
    """updated_at 비교용 스탬프 — SQLite(naive)와 메모리(aware)를 naive UTC로 통일."""
    if dt is None:
        return None
    return dt.replace(tzinfo=None).isoformat()


def node_out(node: Node) -> dict:
    return {
        "id": node.id,
        "space_id": node.space_id,
        "parent_id": node.parent_id,
        "type": node.type,
        "name": node.name,
        "size": node.size,
        "mime": node.mime,
        "created_at": _stamp(node.created_at),
        "updated_at": _stamp(node.updated_at),
    }


def _children(db: Session, space_id: str, parent_id: str | None) -> list[dict]:
    rows = db.scalars(
        select(Node)
        .where(
            Node.space_id == space_id,
            Node.parent_id == parent_id,
            Node.deleted_at.is_(None),
        )
        .order_by(Node.type.desc(), Node.name)  # folder 먼저(f<f? 'folder'>'file' desc), 이름순
    ).all()
    rows.sort(key=lambda n: (0 if n.type == "folder" else 1, n.name))
    return [node_out(n) for n in rows]


@router.get("/spaces/{space_id}/children")
def space_children(
    space_id: str, user: User = Depends(current_user), db: Session = Depends(get_db)
) -> list[dict]:
    space = get_space_checked(db, user, space_id)
    return _children(db, space.id, None)


@router.get("/spaces/{space_id}/folders")
def space_folders(
    space_id: str, user: User = Depends(current_user), db: Session = Depends(get_db)
) -> list[dict]:
    """공간의 모든 폴더(비삭제)를 평면 목록으로 — 사이드바 폴더 트리 구성용."""
    space = get_space_checked(db, user, space_id)
    rows = db.scalars(
        select(Node)
        .where(Node.space_id == space.id, Node.type == "folder", Node.deleted_at.is_(None))
        .order_by(Node.name)
    ).all()
    return [{"id": n.id, "name": n.name, "parent_id": n.parent_id} for n in rows]


@router.get("/spaces/{space_id}/search")
def search_nodes(
    space_id: str,
    q: str = "",
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> list[dict]:
    """공간 안에서 이름에 q가 포함된(대소문자 무시) 비삭제 노드를 재귀로 찾는다.
    각 결과에 상위 폴더 경로(path, 공간 루트 기준 'a/b/c')를 붙여 위치를 보여준다."""
    space = get_space_checked(db, user, space_id)
    term = q.strip()
    if not term:
        return []
    # SQL LIKE 와일드카드/이스케이프 문자를 리터럴로 처리
    escaped = term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    rows = db.scalars(
        select(Node)
        .where(
            Node.space_id == space.id,
            Node.deleted_at.is_(None),
            Node.name.ilike(f"%{escaped}%", escape="\\"),
        )
        .limit(200)
    ).all()
    # 상위 경로 표시용으로 공간의 폴더를 한 번에 로드해 메모리에서 경로를 해석
    folders = db.scalars(
        select(Node).where(
            Node.space_id == space.id, Node.type == "folder", Node.deleted_at.is_(None)
        )
    ).all()
    fmap = {f.id: f for f in folders}

    def path_of(node: Node) -> str:
        parts: list[str] = []
        pid = node.parent_id
        while pid and pid in fmap:
            parts.append(fmap[pid].name)
            pid = fmap[pid].parent_id
        return "/".join(reversed(parts))

    out: list[dict] = []
    for n in sorted(rows, key=lambda n: (0 if n.type == "folder" else 1, n.name)):
        d = node_out(n)
        d["path"] = path_of(n)
        out.append(d)
    return out


@router.get("/favorites")
def list_favorites(
    user: User = Depends(current_user), db: Session = Depends(get_db)
) -> list[dict]:
    """내 즐겨찾기 — 접근 가능하고 휴지통이 아닌 항목만, 최근 추가순. 각 항목에 경로(path)."""
    favs = db.scalars(
        select(Favorite).where(Favorite.user_id == user.id).order_by(Favorite.id.desc())
    ).all()
    if not favs:
        return []
    order = {f.node_id: idx for idx, f in enumerate(favs)}  # 최근 추가 우선
    nodes = db.scalars(
        select(Node).where(Node.id.in_(order.keys()), Node.deleted_at.is_(None))
    ).all()
    # 접근 가능한 공간만(권한 캐시)
    ok_space: dict[str, bool] = {}

    def accessible(space_id: str) -> bool:
        if space_id not in ok_space:
            sp = db.get(Space, space_id)
            ok_space[space_id] = sp is not None and can_access_space(db, user, sp)
        return ok_space[space_id]

    nodes = [n for n in nodes if accessible(n.space_id)]
    # 경로 표시용 폴더맵(관련 공간들)
    space_ids = {n.space_id for n in nodes}
    fmap: dict[str, Node] = {}
    if space_ids:
        folders = db.scalars(
            select(Node).where(
                Node.space_id.in_(space_ids),
                Node.type == "folder",
                Node.deleted_at.is_(None),
            )
        ).all()
        fmap = {f.id: f for f in folders}

    def path_of(node: Node) -> str:
        parts: list[str] = []
        pid = node.parent_id
        while pid and pid in fmap:
            parts.append(fmap[pid].name)
            pid = fmap[pid].parent_id
        return "/".join(reversed(parts))

    out: list[dict] = []
    for n in sorted(nodes, key=lambda n: order.get(n.id, 0)):
        d = node_out(n)
        d["path"] = path_of(n)
        out.append(d)
    return out


@router.get("/favorites/ids")
def favorite_ids(
    user: User = Depends(current_user), db: Session = Depends(get_db)
) -> list[str]:
    """내가 즐겨찾기한 노드 id 목록(가볍게 — 별표 상태 표시용)."""
    return list(
        db.scalars(select(Favorite.node_id).where(Favorite.user_id == user.id)).all()
    )


@router.post("/nodes/{node_id}/favorite")
def add_favorite(
    node_id: str, user: User = Depends(current_user), db: Session = Depends(get_db)
) -> dict:
    node = get_node_checked(db, user, node_id)  # 존재 + 접근 권한 검사
    exists = db.scalar(
        select(Favorite).where(Favorite.user_id == user.id, Favorite.node_id == node.id)
    )
    if not exists:
        db.add(Favorite(user_id=user.id, node_id=node.id))
        db.commit()
    return {"favorited": True}


@router.delete("/nodes/{node_id}/favorite")
def remove_favorite(
    node_id: str, user: User = Depends(current_user), db: Session = Depends(get_db)
) -> dict:
    fav = db.scalar(
        select(Favorite).where(Favorite.user_id == user.id, Favorite.node_id == node_id)
    )
    if fav:
        db.delete(fav)
        db.commit()
    return {"favorited": False}


@router.post("/nodes/{node_id}/view")
def record_view(
    node_id: str, user: User = Depends(current_user), db: Session = Depends(get_db)
) -> dict:
    """항목 열람을 기록('최근 열어본 항목'용). 있으면 viewed_at 갱신, 없으면 추가."""
    node = get_node_checked(db, user, node_id)  # 존재 + 접근 권한 검사
    row = db.scalar(
        select(NodeView).where(NodeView.user_id == user.id, NodeView.node_id == node.id)
    )
    if row:
        row.viewed_at = utcnow()
    else:
        db.add(NodeView(user_id=user.id, node_id=node.id))
    db.commit()
    return {"ok": True}


# ── 편집 잠금(동시 수정 방지) ───────────────────────────────────────────
def _lock_holder_name(db: Session, user_id: str) -> str:
    """편집 잠금 표시명 = 이메일 @ 앞부분(닉네임)."""
    u = db.get(User, user_id)
    return email_nickname(u.email) if u else "다른 사용자"


@router.post("/nodes/{node_id}/lock")
def acquire_edit_lock(
    node_id: str, user: User = Depends(current_user), db: Session = Depends(get_db)
) -> dict:
    """편집 잠금 획득/갱신(하트비트). 내가 쥐면 held_by_me=True, 남이 편집 중이면 False."""
    node = get_node_checked(db, user, node_id)  # 존재 + 접근 권한 검사
    ok, lock = locks.acquire(db, node.id, user.id)
    if ok:
        return {"held_by_me": True, "holder": ""}
    return {"held_by_me": False, "holder": _lock_holder_name(db, lock.user_id)}


@router.get("/nodes/{node_id}/lock")
def edit_lock_status(
    node_id: str, user: User = Depends(current_user), db: Session = Depends(get_db)
) -> dict:
    """현재 잠금 상태 조회 — 읽기 전용 뷰어가 폴링해 해제/인수 시점을 감지한다."""
    node = get_node_checked(db, user, node_id)
    lock = locks.get_active(db, node.id)
    if lock is None:
        return {"locked": False, "held_by_me": False, "holder": ""}
    if lock.user_id == user.id:
        return {"locked": False, "held_by_me": True, "holder": ""}
    return {"locked": True, "held_by_me": False, "holder": _lock_holder_name(db, lock.user_id)}


@router.post("/nodes/{node_id}/lock/release")
def release_edit_lock(
    node_id: str, user: User = Depends(current_user), db: Session = Depends(get_db)
) -> dict:
    """편집 잠금 해제(닫기/이탈). 내 잠금만 풀린다. sendBeacon 호환 위해 POST."""
    locks.release(db, node_id, user.id)
    return {"released": True}


@router.get("/recent")
def list_recent(
    user: User = Depends(current_user), db: Session = Depends(get_db)
) -> list[dict]:
    """내가 최근 열어본 항목 — 접근 가능하고 휴지통이 아닌 것만, 최근 열람순(최대 40). 경로 포함."""
    views = db.scalars(
        select(NodeView)
        .where(NodeView.user_id == user.id)
        .order_by(NodeView.viewed_at.desc())
        .limit(120)
    ).all()
    if not views:
        return []
    order = {v.node_id: idx for idx, v in enumerate(views)}  # 최근 열람 우선
    nodes = db.scalars(
        select(Node).where(Node.id.in_(order.keys()), Node.deleted_at.is_(None))
    ).all()
    ok_space: dict[str, bool] = {}

    def accessible(space_id: str) -> bool:
        if space_id not in ok_space:
            sp = db.get(Space, space_id)
            ok_space[space_id] = sp is not None and can_access_space(db, user, sp)
        return ok_space[space_id]

    nodes = [n for n in nodes if accessible(n.space_id)]
    space_ids = {n.space_id for n in nodes}
    fmap: dict[str, Node] = {}
    if space_ids:
        folders = db.scalars(
            select(Node).where(
                Node.space_id.in_(space_ids),
                Node.type == "folder",
                Node.deleted_at.is_(None),
            )
        ).all()
        fmap = {f.id: f for f in folders}

    def path_of(node: Node) -> str:
        parts: list[str] = []
        pid = node.parent_id
        while pid and pid in fmap:
            parts.append(fmap[pid].name)
            pid = fmap[pid].parent_id
        return "/".join(reversed(parts))

    out: list[dict] = []
    for n in sorted(nodes, key=lambda n: order.get(n.id, 0))[:40]:
        d = node_out(n)
        d["path"] = path_of(n)
        out.append(d)
    return out


@router.get("/nodes/{node_id}/children")
def node_children(
    node_id: str, user: User = Depends(current_user), db: Session = Depends(get_db)
) -> list[dict]:
    node = get_node_checked(db, user, node_id)
    if node.type != "folder":
        raise HTTPException(status_code=400, detail="폴더가 아닙니다")
    return _children(db, node.space_id, node.id)


class CreateFolderBody(BaseModel):
    space_id: str
    parent_id: str | None = None
    name: str


@router.post("/nodes", status_code=201)
def create_folder(
    body: CreateFolderBody, user: User = Depends(current_user), db: Session = Depends(get_db)
) -> dict:
    space = get_space_checked(db, user, body.space_id)
    parent_id = None
    if body.parent_id:
        parent = get_node_checked(db, user, body.parent_id)
        if parent.type != "folder" or parent.space_id != space.id:
            raise HTTPException(status_code=422, detail="상위 폴더가 올바르지 않습니다")
        parent_id = parent.id
    name = unique_name(db, space.id, parent_id, clean_name(body.name))
    node = Node(
        space_id=space.id, parent_id=parent_id, type="folder", name=name, created_by=user.id
    )
    db.add(node)
    db.flush()
    audit.log(db, "folder_create", user_id=user.id, node_id=node.id, detail=name)
    return node_out(node)


def _resolve_upload_parent(
    db: Session,
    user: User,
    space: Space,
    base_parent_id: str | None,
    rel_path: str | None,
) -> str | None:
    """rel_path(예: 'docs/2026/report.md')의 디렉터리 부분을 base_parent 아래에
    find-or-create 하고, 파일이 들어갈 최종 폴더 id를 돌려준다. 같은 이름 폴더가
    이미 있으면 (suffix 없이) 그대로 재사용해 구조를 합친다."""
    if not rel_path:
        return base_parent_id
    parts = [p for p in rel_path.replace("\\", "/").split("/") if p not in ("", ".", "..")]
    dirs = parts[:-1]  # 마지막 성분은 파일명
    parent_id = base_parent_id
    for raw in dirs:
        name = clean_name(raw)
        existing = db.scalar(
            select(Node).where(
                Node.space_id == space.id,
                Node.parent_id == parent_id,
                Node.name == name,
                Node.type == "folder",
                Node.deleted_at.is_(None),
            )
        )
        if existing:
            parent_id = existing.id
            continue
        folder = Node(
            space_id=space.id, parent_id=parent_id, type="folder", name=name, created_by=user.id
        )
        db.add(folder)
        db.flush()
        audit.log(db, "folder_create", user_id=user.id, node_id=folder.id, detail=name)
        parent_id = folder.id
    return parent_id


def _do_upload(
    db: Session,
    user: User,
    space: Space,
    parent_id: str | None,
    upload: UploadFile,
    rel_path: str | None = None,
) -> dict:
    parent_id = _resolve_upload_parent(db, user, space, parent_id, rel_path)
    settings = get_settings()
    storage = build_storage(settings)
    try:
        key, size, sha = storage.put_stream(
            upload.file, settings.max_upload_mb * 1024 * 1024
        )
    except FileTooLargeError:
        raise HTTPException(
            status_code=413, detail=f"파일당 최대 {settings.max_upload_mb}MB까지 올릴 수 있습니다"
        ) from None
    name = unique_name(db, space.id, parent_id, clean_name(upload.filename or "이름없음"))
    mime = upload.content_type or mimetypes.guess_type(name)[0] or "application/octet-stream"
    node = Node(
        space_id=space.id,
        parent_id=parent_id,
        type="file",
        name=name,
        size=size,
        mime=mime,
        storage_key=key,
        sha256=sha,
        created_by=user.id,
    )
    db.add(node)
    db.flush()
    audit.log(db, "upload", user_id=user.id, node_id=node.id, detail=f"{name} ({size}B)")
    return node_out(node)


@router.post("/spaces/{space_id}/files", status_code=201)
def upload_to_space_root(
    space_id: str,
    file: UploadFile,
    rel_path: str = Form(""),
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> dict:
    space = get_space_checked(db, user, space_id)
    return _do_upload(db, user, space, None, file, rel_path)


@router.post("/nodes/{node_id}/files", status_code=201)
def upload_to_folder(
    node_id: str,
    file: UploadFile,
    rel_path: str = Form(""),
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> dict:
    parent = get_node_checked(db, user, node_id)
    if parent.type != "folder":
        raise HTTPException(status_code=400, detail="폴더가 아닙니다")
    space = db.get(Space, parent.space_id)
    return _do_upload(db, user, space, parent.id, file, rel_path)

def _node_sha256(storage: StorageBackend, node: Node) -> str:
    """업로드 때 저장한 sha가 있으면 그걸, 없으면(구 데이터) 계산."""
    return node.sha256 or storage.sha256(node.storage_key)


@router.get("/files/{node_id}")
def download_file(
    node_id: str,
    request: Request,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
    storage: StorageBackend = Depends(get_storage),
):
    node = get_node_checked(db, user, node_id)
    if node.type != "file":
        raise HTTPException(status_code=400, detail="파일이 아닙니다")
    audit.log(db, "download", user_id=user.id, node_id=node.id, detail=node.name)
    return serve_blob(
        storage,
        node.storage_key,
        filename=node.name,
        media_type=node.mime or "application/octet-stream",
        disposition="attachment",
        request=request,
        extra_headers={"X-Checksum-SHA256": _node_sha256(storage, node)},
    )


@router.get("/files/{node_id}/raw")
def raw_file(
    node_id: str,
    request: Request,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
    storage: StorageBackend = Depends(get_storage),
):
    node = get_node_checked(db, user, node_id)
    if node.type != "file":
        raise HTTPException(status_code=400, detail="파일이 아닙니다")
    media_type = media_type_for(node)
    extra: dict[str, str] = {}
    if media_type in ("text/html", "application/xhtml+xml"):
        # 업로드된 HTML의 스크립트가 앱 오리진에서 실행돼 세션을 탈취하지 못하게
        # 격리(sandbox)해서 내려준다. iframe sandbox와 이중 방어.
        extra = {"Content-Security-Policy": "sandbox", "X-Content-Type-Options": "nosniff"}
    return serve_blob(
        storage,
        node.storage_key,
        filename=node.name,
        media_type=media_type,
        disposition="inline",
        request=request,
        extra_headers=extra,
    )


@router.get("/files/{node_id}/preview.pdf")
def office_preview(
    node_id: str,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
    storage: StorageBackend = Depends(get_storage),
):
    """오피스 문서(PPT·워드·엑셀 등)를 PDF로 변환해 미리보기용으로 내려준다."""
    node = get_node_checked(db, user, node_id)
    if node.type != "file" or not is_office(node.name):
        raise HTTPException(status_code=400, detail="오피스 문서가 아닙니다")
    if not storage.exists(node.storage_key):
        raise HTTPException(status_code=410, detail="파일 본체가 없습니다")
    cache_dir = Path(get_settings().data_dir) / "preview_cache"
    cached = cache_dir / f"{node.storage_key}.pdf"
    try:
        if cached.is_file():
            pdf = cached
        else:
            # 원격 스토리지면 원본을 임시파일로 받아 변환 (로컬이면 원본 경로 그대로)
            with storage.local_copy(node.storage_key) as src:
                pdf = convert_to_pdf(src, cache_dir, node.storage_key)
    except OfficeConvertError as exc:
        raise HTTPException(status_code=503, detail=f"미리보기를 만들 수 없습니다: {exc}") from exc
    return FileResponse(
        pdf,
        media_type="application/pdf",
        headers={"Content-Disposition": _content_disposition("inline", f"{node.name}.pdf")},
    )


@router.get("/files/{node_id}/preview.mp4")
def video_preview(
    node_id: str,
    request: Request,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
    storage: StorageBackend = Depends(get_storage),
):
    """영상 미리보기용 서빙. 오디오가 브라우저 비호환 코덱(AC-3 등)이면 AAC로 변환해
    내려주고, 호환이면 원본을 그대로 스트리밍한다. 판정·변환 결과는 캐시해 재사용."""
    node = get_node_checked(db, user, node_id)
    if node.type != "file" or not is_video(node.name):
        raise HTTPException(status_code=400, detail="영상 파일이 아닙니다")
    if not storage.exists(node.storage_key):
        raise HTTPException(status_code=410, detail="파일 본체가 없습니다")

    cache_dir = Path(get_settings().data_dir) / "preview_cache"
    transcoded = cache_dir / f"{node.storage_key}.mp4"
    passthrough = cache_dir / f"{node.storage_key}.audio_ok"

    def serve_original():
        return serve_blob(
            storage,
            node.storage_key,
            filename=node.name,
            media_type=media_type_for(node),
            disposition="inline",
            request=request,
        )

    def serve_transcoded():
        return FileResponse(
            transcoded,
            media_type="video/mp4",
            headers={"Content-Disposition": _content_disposition("inline", node.name)},
        )

    # 이미 판정된 경우: 변환본이 있으면 그걸, '오디오 호환' 표시가 있으면 원본을.
    if transcoded.is_file():
        return serve_transcoded()
    if passthrough.is_file():
        return serve_original()

    # 첫 요청: 원본을 받아 오디오 코덱을 확인 → 비호환이면 오디오만 AAC로 변환.
    codec = ""
    compatible = True
    try:
        with storage.local_copy(node.storage_key) as src:
            codec = audio_codec(src)
            compatible = audio_is_browser_ok(codec)
            if not compatible:
                transcode_audio_to_aac(src, cache_dir, node.storage_key)
    except TranscodeError:
        # ffmpeg/ffprobe 문제 등 — 변환 못 해도 원본이라도 내려준다(그림은 나옴).
        return serve_original()

    if compatible:
        cache_dir.mkdir(parents=True, exist_ok=True)
        passthrough.write_text(codec or "none", encoding="utf-8")
        return serve_original()
    return serve_transcoded()


def collect_tar_entries(db: Session, root: Node):
    """폴더 서브트리를 (파일 노드|None(=디렉토리), 아카이브명)으로 평탄화 — 삭제 항목 제외."""
    def walk(node: Node, prefix: str):
        children = db.scalars(
            select(Node).where(
                Node.parent_id == node.id, Node.deleted_at.is_(None)
            )
        ).all()
        children.sort(key=lambda n: (0 if n.type == "folder" else 1, n.name))
        for child in children:
            arcname = f"{prefix}/{child.name}"
            if child.type == "folder":
                yield (None, arcname)
                yield from walk(child, arcname)
            else:
                yield (child, arcname)

    yield (None, root.name)
    yield from walk(root, root.name)


@router.get("/nodes/{node_id}/tar")
def download_folder_tar(
    node_id: str,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
    storage: StorageBackend = Depends(get_storage),
):
    node = get_node_checked(db, user, node_id)
    if node.type != "folder":
        raise HTTPException(status_code=400, detail="폴더가 아닙니다")
    entries = list(collect_tar_entries(db, node))
    audit.log(db, "tar_download", user_id=user.id, node_id=node.id, detail=node.name)
    filename = f"{node.name}.tar.gz"
    return StreamingResponse(
        stream_tar_gz(storage, entries),
        media_type="application/gzip",
        headers={"Content-Disposition": _content_disposition("attachment", filename)},
    )


class PatchNodeBody(BaseModel):
    name: str | None = None
    parent_id: str | None = None
    space_id: str | None = None
    move: bool = False  # parent_id=null(루트)로 이동과 "변경 없음"을 구분


@router.patch("/nodes/{node_id}")
def patch_node(
    node_id: str,
    body: PatchNodeBody,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> dict:
    node = get_node_checked(db, user, node_id)

    if body.name is not None:
        node.name = unique_name(db, node.space_id, node.parent_id, clean_name(body.name))
        audit.log(db, "rename", user_id=user.id, node_id=node.id, detail=node.name)

    if body.move:
        # 대상: parent_id가 있으면 그 폴더로, 없으면 space_id(기본: 현재 공간)의 루트로
        if body.parent_id:
            target_parent = get_node_checked(db, user, body.parent_id)
            if target_parent.type != "folder":
                raise HTTPException(status_code=422, detail="대상이 폴더가 아닙니다")
            if node.type == "folder" and is_descendant(db, target_parent.id, node.id):
                raise HTTPException(status_code=400, detail="자기 하위 폴더로는 이동할 수 없습니다")
            target_space = get_space_checked(db, user, target_parent.space_id)
            new_parent_id = target_parent.id
        else:
            target_space = get_space_checked(db, user, body.space_id or node.space_id)
            new_parent_id = None
        # 출발·도착 공간 모두 쓰기 가능해야 (매트릭스의 이동 규칙)
        get_space_checked(db, user, node.space_id)
        node.name = unique_name(db, target_space.id, new_parent_id, node.name)
        _move_subtree_space(db, node, target_space.id)
        node.parent_id = new_parent_id
        audit.log(db, "move", user_id=user.id, node_id=node.id, detail=target_space.type)

    node.updated_at = utcnow()
    db.flush()
    return node_out(node)


def _move_subtree_space(db: Session, node: Node, space_id: str) -> None:
    node.space_id = space_id
    if node.type == "folder":
        children = db.scalars(select(Node).where(Node.parent_id == node.id)).all()
        for child in children:
            _move_subtree_space(db, child, space_id)


def _copy_node(
    db: Session,
    storage: StorageBackend,
    user: User,
    src: Node,
    target_space_id: str,
    parent_id: str | None,
    name: str | None = None,
) -> Node:
    """src(파일/폴더)를 target 공간의 parent 아래로 복사(재귀). 파일은 blob도 복제."""
    new_name = name or unique_name(db, target_space_id, parent_id, src.name)
    new_key = ""
    if src.type == "file" and src.storage_key:
        new_key = storage.copy_blob(src.storage_key)
    copy = Node(
        space_id=target_space_id,
        parent_id=parent_id,
        type=src.type,
        name=new_name,
        size=src.size,
        mime=src.mime,
        storage_key=new_key,
        sha256=src.sha256,  # 내용 동일 → 체크섬 그대로
        created_by=user.id,
    )
    db.add(copy)
    db.flush()
    if src.type == "folder":
        children = db.scalars(
            select(Node).where(Node.parent_id == src.id, Node.deleted_at.is_(None))
        ).all()
        for child in children:
            _copy_node(db, storage, user, child, target_space_id, copy.id)
    return copy


class CopyNodeBody(BaseModel):
    space_id: str | None = None
    parent_id: str | None = None


@router.post("/nodes/{node_id}/copy", status_code=201)
def copy_node(
    node_id: str,
    body: CopyNodeBody,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
    storage: StorageBackend = Depends(get_storage),
) -> dict:
    """노드를 다른 공간(또는 폴더)으로 복사 — 원본은 그대로. 출발·도착 공간 모두 접근 가능해야."""
    src = get_node_checked(db, user, node_id)  # 출발 공간 접근 확인 포함
    if body.parent_id:
        target_parent = get_node_checked(db, user, body.parent_id)
        if target_parent.type != "folder":
            raise HTTPException(status_code=422, detail="대상이 폴더가 아닙니다")
        target_space = get_space_checked(db, user, target_parent.space_id)
        parent_id = target_parent.id
    else:
        target_space = get_space_checked(db, user, body.space_id or src.space_id)
        parent_id = None
    copy = _copy_node(db, storage, user, src, target_space.id, parent_id)
    audit.log(db, "copy", user_id=user.id, node_id=copy.id, detail=copy.name)
    return node_out(copy)


@router.delete("/nodes/{node_id}")
def soft_delete(
    node_id: str, user: User = Depends(current_user), db: Session = Depends(get_db)
) -> dict:
    node = get_node_checked(db, user, node_id)
    node.deleted_at = utcnow()
    audit.log(db, "delete", user_id=user.id, node_id=node.id, detail=node.name)
    return {"ok": True}


@router.get("/spaces/{space_id}/trash")
def list_trash(
    space_id: str, user: User = Depends(current_user), db: Session = Depends(get_db)
) -> list[dict]:
    space = get_space_checked(db, user, space_id)
    rows = db.scalars(
        select(Node)
        .where(Node.space_id == space.id, Node.deleted_at.is_not(None))
        .order_by(Node.deleted_at.desc())
    ).all()
    # 삭제 시각과 자동 완전삭제 예정 시각(= 삭제시각 + 보존기간)을 함께 내려
    # 프런트가 "완전삭제까지 N일 남음"을 표시할 수 있게 한다. 예정시각은 서버가
    # 보존기간(get_settings)으로 계산 — 프런트에 보존기간 상수를 별도로 넘길 필요가 없다.
    retention = timedelta(days=get_settings().trash_retention_days)

    def out(n: Node) -> dict:
        d = node_out(n)
        d["deleted_at"] = _stamp(n.deleted_at)
        d["purge_at"] = _stamp(n.deleted_at + retention) if n.deleted_at else None
        return d

    return [out(n) for n in rows]


@router.post("/nodes/{node_id}/restore")
def restore_node(
    node_id: str, user: User = Depends(current_user), db: Session = Depends(get_db)
) -> dict:
    node = get_node_checked(db, user, node_id, include_deleted=True)
    if node.deleted_at is None:
        raise HTTPException(status_code=400, detail="휴지통에 있지 않습니다")
    parent = db.get(Node, node.parent_id) if node.parent_id else None
    if parent is not None and parent.deleted_at is not None:
        node.parent_id = None  # 부모가 아직 휴지통이면 루트로 복원
    node.name = unique_name(db, node.space_id, node.parent_id, node.name)
    node.deleted_at = None
    audit.log(db, "restore", user_id=user.id, node_id=node.id, detail=node.name)
    return node_out(node)


@router.delete("/nodes/{node_id}/purge")
def purge_own_node(
    node_id: str,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
    storage: StorageBackend = Depends(get_storage),
) -> dict:
    """휴지통 항목을 영구 삭제(본인). get_node_checked가 공간 접근 권한을 검사하므로
    자기가 접근 가능한 공간의 항목만 지울 수 있고, 휴지통에 있는 것만 가능하다."""
    node = get_node_checked(db, user, node_id, include_deleted=True)
    if node.deleted_at is None:
        raise HTTPException(status_code=400, detail="휴지통에 있는 항목만 영구 삭제할 수 있습니다")
    removed = purge_subtree(db, storage, node)
    audit.log(db, "purge", user_id=user.id, node_id=node_id, detail=f"{node.name} ({removed})")
    return {"ok": True, "removed": removed}


@router.get("/nodes/{node_id}/path")
def node_path(
    node_id: str, user: User = Depends(current_user), db: Session = Depends(get_db)
) -> dict:
    """딥링크 복원용: 노드 + 조상 폴더 경로(루트→직전) + 공간."""
    node = get_node_checked(db, user, node_id)
    ancestors: list[dict] = []
    current = db.get(Node, node.parent_id) if node.parent_id else None
    hops = 0
    while current is not None and hops < 100:
        ancestors.append(node_out(current))
        current = db.get(Node, current.parent_id) if current.parent_id else None
        hops += 1
    ancestors.reverse()
    space = db.get(Space, node.space_id)
    return {"node": node_out(node), "ancestors": ancestors, "space_id": space.id}

class PutContentBody(BaseModel):
    content: str
    base_updated_at: str | None = None  # 낙관적 잠금: 클라이언트가 마지막으로 본 updated_at


@router.put("/files/{node_id}/content")
def save_content(
    node_id: str,
    body: PutContentBody,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
    storage: StorageBackend = Depends(get_storage),
) -> dict:
    node = get_node_checked(db, user, node_id)
    if node.type != "file":
        raise HTTPException(status_code=400, detail="파일이 아닙니다")

    current_stamp = _stamp(node.updated_at)
    if body.base_updated_at is not None and body.base_updated_at != current_stamp:
        raise HTTPException(
            status_code=409,
            detail="다른 사람이 먼저 수정했습니다. 새로고침 후 다시 시도하세요",
        )

    settings = get_settings()
    data = body.content.encode("utf-8")
    try:
        key, size, sha = storage.put_bytes(data, settings.max_upload_mb * 1024 * 1024)
    except FileTooLargeError:
        raise HTTPException(status_code=413, detail="문서가 너무 큽니다") from None

    old_key = node.storage_key
    node.storage_key = key
    node.size = size
    node.sha256 = sha
    node.updated_at = utcnow()
    db.flush()
    storage.delete(old_key)
    audit.log(db, "edit", user_id=user.id, node_id=node.id, detail=node.name)
    return node_out(node)
