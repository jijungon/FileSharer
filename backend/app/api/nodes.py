import mimetypes
import unicodedata
import urllib.parse
from pathlib import PurePosixPath

from fastapi import APIRouter, Depends, HTTPException, UploadFile
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import get_settings
from ..deps import current_user, get_db
from ..models import Node, Space, User, utcnow
from ..services import audit
from ..services.permissions import (
    get_node_checked,
    get_space_checked,
    is_descendant,
)
from ..services.storage import FileTooLargeError, LocalStorage
from ..services.tar_stream import stream_tar_gz

router = APIRouter(prefix="/api", tags=["files"])


def get_storage() -> LocalStorage:
    return LocalStorage(get_settings().data_dir)


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


def node_out(node: Node) -> dict:
    return {
        "id": node.id,
        "space_id": node.space_id,
        "parent_id": node.parent_id,
        "type": node.type,
        "name": node.name,
        "size": node.size,
        "mime": node.mime,
        "updated_at": node.updated_at.isoformat() if node.updated_at else None,
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


def _do_upload(
    db: Session,
    user: User,
    space: Space,
    parent_id: str | None,
    upload: UploadFile,
) -> dict:
    settings = get_settings()
    storage = LocalStorage(settings.data_dir)
    try:
        key, size, _sha = storage.put_stream(
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
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> dict:
    space = get_space_checked(db, user, space_id)
    return _do_upload(db, user, space, None, file)


@router.post("/nodes/{node_id}/files", status_code=201)
def upload_to_folder(
    node_id: str,
    file: UploadFile,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> dict:
    parent = get_node_checked(db, user, node_id)
    if parent.type != "folder":
        raise HTTPException(status_code=400, detail="폴더가 아닙니다")
    space = db.get(Space, parent.space_id)
    return _do_upload(db, user, space, parent.id, file)


def _content_disposition(kind: str, filename: str) -> str:
    quoted = urllib.parse.quote(filename)
    return f"{kind}; filename*=UTF-8''{quoted}"


@router.get("/files/{node_id}")
def download_file(
    node_id: str,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
    storage: LocalStorage = Depends(get_storage),
):
    node = get_node_checked(db, user, node_id)
    if node.type != "file":
        raise HTTPException(status_code=400, detail="파일이 아닙니다")
    path = storage.path_for(node.storage_key)
    if not path.is_file():
        raise HTTPException(status_code=410, detail="파일 본체가 없습니다")
    audit.log(db, "download", user_id=user.id, node_id=node.id, detail=node.name)
    return FileResponse(
        path,
        media_type=node.mime or "application/octet-stream",
        headers={
            "Content-Disposition": _content_disposition("attachment", node.name),
            "X-Checksum-SHA256": storage.sha256(node.storage_key),
        },
    )


@router.get("/files/{node_id}/raw")
def raw_file(
    node_id: str,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
    storage: LocalStorage = Depends(get_storage),
):
    node = get_node_checked(db, user, node_id)
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


def collect_tar_entries(db: Session, storage: LocalStorage, root: Node):
    """폴더 서브트리를 (경로|None, 아카이브명)으로 평탄화 — 삭제 항목 제외."""
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
                path = storage.path_for(child.storage_key)
                if path.is_file():
                    yield (path, arcname)

    yield (None, root.name)
    yield from walk(root, root.name)


@router.get("/nodes/{node_id}/tar")
def download_folder_tar(
    node_id: str,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
    storage: LocalStorage = Depends(get_storage),
):
    node = get_node_checked(db, user, node_id)
    if node.type != "folder":
        raise HTTPException(status_code=400, detail="폴더가 아닙니다")
    entries = list(collect_tar_entries(db, storage, node))
    audit.log(db, "tar_download", user_id=user.id, node_id=node.id, detail=node.name)
    filename = f"{node.name}.tar.gz"
    return StreamingResponse(
        stream_tar_gz(entries),
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
    return [node_out(n) for n in rows]


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
