import io

from tests.conftest import ADMIN_EMAIL, ADMIN_PASSWORD, login


def upload(client, url, name, content=b"hi"):
    return client.post(url, files={"file": (name, io.BytesIO(content), "text/plain")})


def spaces_of(client):
    return {s["type"]: s for s in client.get("/api/spaces").json()}


def test_favorite_add_list_remove(admin_client):
    """즐겨찾기 추가 → 목록/ids에 노출(경로 포함) → 해제 → 사라짐. 추가는 멱등."""
    sp = spaces_of(admin_client)
    pid = sp["personal"]["id"]
    folder = admin_client.post("/api/nodes", json={"space_id": pid, "name": "즐겨폴더"}).json()
    node = upload(admin_client, f"/api/nodes/{folder['id']}/files", "중요.txt").json()

    # 추가(멱등)
    assert admin_client.post(f"/api/nodes/{node['id']}/favorite").json() == {"favorited": True}
    assert admin_client.post(f"/api/nodes/{node['id']}/favorite").json() == {"favorited": True}

    favs = admin_client.get("/api/favorites").json()
    assert [f["id"] for f in favs] == [node["id"]]
    assert favs[0]["path"] == "즐겨폴더"  # 상위 경로 포함
    assert admin_client.get("/api/favorites/ids").json() == [node["id"]]

    # 해제
    assert admin_client.delete(f"/api/nodes/{node['id']}/favorite").json() == {"favorited": False}
    assert admin_client.get("/api/favorites").json() == []
    assert admin_client.get("/api/favorites/ids").json() == []


def test_favorite_list_excludes_trashed(admin_client):
    """즐겨찾기해도 휴지통으로 가면 목록에서 빠진다."""
    sp = spaces_of(admin_client)
    pid = sp["personal"]["id"]
    node = upload(admin_client, f"/api/spaces/{pid}/files", "곧삭제.txt").json()
    admin_client.post(f"/api/nodes/{node['id']}/favorite")
    assert any(f["id"] == node["id"] for f in admin_client.get("/api/favorites").json())

    admin_client.delete(f"/api/nodes/{node['id']}")  # 휴지통
    assert all(f["id"] != node["id"] for f in admin_client.get("/api/favorites").json())


def test_cannot_favorite_in_others_personal_space(admin_client, db):
    """프라이버시: 남의 개인공간 항목은 즐겨찾기 불가."""
    from app.bootstrap import create_user

    create_user(db, email="fav-other@test.local", password="pw-123456")
    db.commit()
    admin_client.post("/api/auth/logout")
    login(admin_client, "fav-other@test.local", "pw-123456")
    opid = spaces_of(admin_client)["personal"]["id"]
    node = upload(admin_client, f"/api/spaces/{opid}/files", "남의것.txt").json()

    admin_client.post("/api/auth/logout")
    login(admin_client, ADMIN_EMAIL, ADMIN_PASSWORD)
    assert admin_client.post(f"/api/nodes/{node['id']}/favorite").status_code in (403, 404)
