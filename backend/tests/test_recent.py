import io

from tests.conftest import ADMIN_EMAIL, ADMIN_PASSWORD, login


def upload(client, url, name, content=b"hi"):
    return client.post(url, files={"file": (name, io.BytesIO(content), "text/plain")})


def spaces_of(client):
    return {s["type"]: s for s in client.get("/api/spaces").json()}


def test_recent_records_and_orders_by_view(admin_client):
    """열람 기록 → /recent에 최근순으로. 다시 열면 맨 앞으로. 경로 포함."""
    sp = spaces_of(admin_client)
    pid = sp["personal"]["id"]
    folder = admin_client.post("/api/nodes", json={"space_id": pid, "name": "최근폴더"}).json()
    a = upload(admin_client, f"/api/spaces/{pid}/files", "가.txt").json()
    b = upload(admin_client, f"/api/nodes/{folder['id']}/files", "나.txt").json()

    assert admin_client.post(f"/api/nodes/{a['id']}/view").json() == {"ok": True}
    assert admin_client.post(f"/api/nodes/{b['id']}/view").json() == {"ok": True}

    recent = admin_client.get("/api/recent").json()
    assert [r["id"] for r in recent] == [b["id"], a["id"]]  # 최근 열람 우선
    assert next(r for r in recent if r["id"] == b["id"])["path"] == "최근폴더"

    # a를 다시 열면 맨 앞으로 (중복 없이 갱신)
    admin_client.post(f"/api/nodes/{a['id']}/view")
    recent = admin_client.get("/api/recent").json()
    assert [r["id"] for r in recent] == [a["id"], b["id"]]


def test_recent_excludes_trashed(admin_client):
    """열람한 항목이 휴지통으로 가면 최근 목록에서 빠진다."""
    sp = spaces_of(admin_client)
    pid = sp["personal"]["id"]
    node = upload(admin_client, f"/api/spaces/{pid}/files", "삭제될것.txt").json()
    admin_client.post(f"/api/nodes/{node['id']}/view")
    assert any(r["id"] == node["id"] for r in admin_client.get("/api/recent").json())

    admin_client.delete(f"/api/nodes/{node['id']}")
    assert all(r["id"] != node["id"] for r in admin_client.get("/api/recent").json())


def test_cannot_record_view_in_others_personal_space(admin_client, db):
    """프라이버시: 남의 개인공간 항목은 열람 기록 불가."""
    from app.bootstrap import create_user

    create_user(db, email="rv-other@test.local", password="pw-123456")
    db.commit()
    admin_client.post("/api/auth/logout")
    login(admin_client, "rv-other@test.local", "pw-123456")
    opid = spaces_of(admin_client)["personal"]["id"]
    node = upload(admin_client, f"/api/spaces/{opid}/files", "남의것.txt").json()

    admin_client.post("/api/auth/logout")
    login(admin_client, ADMIN_EMAIL, ADMIN_PASSWORD)
    assert admin_client.post(f"/api/nodes/{node['id']}/view").status_code in (403, 404)
