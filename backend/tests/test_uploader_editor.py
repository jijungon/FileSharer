import io

from app.bootstrap import create_user
from tests.conftest import login


def spaces_of(client):
    return {s["type"]: s for s in client.get("/api/spaces").json()}


def test_uploader_and_editor_nicknames(admin_client, db):
    """업로더=생성자 닉네임, 수정자=마지막 수정자 닉네임(신규 땐 업로더로 폴백), 목록에도 반영."""
    oid = spaces_of(admin_client)["org"]["id"]
    node = admin_client.post(
        f"/api/spaces/{oid}/files",
        files={"file": ("collab.md", io.BytesIO(b"# hi"), "text/markdown")},
    ).json()
    # 업로드 직후: 업로더·수정자 둘 다 업로더(admin)
    assert node["uploader"] == "admin"
    assert node["editor"] == "admin"

    # 다른 사용자가 저장하면 수정자만 바뀐다(업로더 불변)
    create_user(db, email="bob@corp.example", password="pw-123456")
    db.commit()
    admin_client.post("/api/auth/logout")
    login(admin_client, "bob@corp.example", "pw-123456")
    saved = admin_client.put(
        f"/api/files/{node['id']}/content",
        json={"content": "# hi bob", "base_updated_at": None},
    ).json()
    assert saved["uploader"] == "admin"
    assert saved["editor"] == "bob"

    # 목록 조회에도 반영
    row = next(
        r for r in admin_client.get(f"/api/spaces/{oid}/children").json() if r["id"] == node["id"]
    )
    assert row["uploader"] == "admin"
    assert row["editor"] == "bob"


def test_rename_updates_editor(admin_client, db):
    """리네임(수정)해도 수정자가 갱신된다."""
    oid = spaces_of(admin_client)["org"]["id"]
    node = admin_client.post(
        f"/api/spaces/{oid}/files",
        files={"file": ("a.md", io.BytesIO(b"x"), "text/markdown")},
    ).json()
    create_user(db, email="carol@corp.example", password="pw-123456")
    db.commit()
    admin_client.post("/api/auth/logout")
    login(admin_client, "carol@corp.example", "pw-123456")
    renamed = admin_client.patch(f"/api/nodes/{node['id']}", json={"name": "b.md"}).json()
    assert renamed["uploader"] == "admin"
    assert renamed["editor"] == "carol"
