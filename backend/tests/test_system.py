import io

from tests.conftest import login


def upload(client, url, name, content=b"hello"):
    return client.post(url, files={"file": (name, io.BytesIO(content), "text/plain")})


def personal_space(client):
    return next(s for s in client.get("/api/spaces").json() if s["type"] == "personal")


def test_system_endpoints_require_admin(admin_client, db):
    from app.bootstrap import create_user

    create_user(db, email="pleb@test.local", password="pw-123456")
    db.commit()
    admin_client.post("/api/auth/logout")
    login(admin_client, "pleb@test.local", "pw-123456")

    assert admin_client.get("/api/system/disk").status_code == 403
    assert admin_client.get("/api/system/audit").status_code == 403


def test_disk_usage_fields(admin_client):
    res = admin_client.get("/api/system/disk")
    assert res.status_code == 200
    body = res.json()
    assert body["total"] > 0 and body["free"] > 0
    assert 0 <= body["used_ratio"] <= 1
    assert body["blob_bytes"] >= 0
    assert isinstance(body["warn"], bool)


def test_audit_log_records_and_lists(admin_client):
    sp = personal_space(admin_client)
    upload(admin_client, f"/api/spaces/{sp['id']}/files", "감사.txt")
    rows = admin_client.get("/api/system/audit").json()
    assert any(r["action"] == "upload" and "감사.txt" in r["detail"] for r in rows)
    only_upload = admin_client.get("/api/system/audit", params={"action": "upload"}).json()
    assert all(r["action"] == "upload" for r in only_upload)
    assert rows[0]["user"].endswith("@test.local")


def test_purge_removes_rows_blob_and_shares(admin_client, client):
    sp = personal_space(admin_client)
    folder = admin_client.post(
        "/api/nodes", json={"space_id": sp["id"], "name": "지울폴더"}
    ).json()
    node = upload(admin_client, f"/api/nodes/{folder['id']}/files", "안녕.txt", b"bye").json()
    share = admin_client.post(f"/api/nodes/{node['id']}/shares", json={}).json()

    # 휴지통 경유 전 purge는 400
    assert admin_client.delete(f"/api/system/nodes/{folder['id']}/purge").status_code == 400

    admin_client.delete(f"/api/nodes/{folder['id']}")
    res = admin_client.delete(f"/api/system/nodes/{folder['id']}/purge")
    assert res.status_code == 200
    assert res.json()["removed"] == 2

    # 트래시에서도 사라지고, 공유 링크도 410/404
    assert admin_client.get(f"/api/spaces/{sp['id']}/trash").json() == []
    assert admin_client.get(f"/s/{share['token']}/download").status_code in (404, 410)


def test_member_cannot_purge(admin_client, db):
    from app.bootstrap import create_user

    create_user(db, email="np@test.local", password="pw-123456")
    db.commit()
    sp = personal_space(admin_client)
    node = upload(admin_client, f"/api/spaces/{sp['id']}/files", "x.txt").json()
    admin_client.delete(f"/api/nodes/{node['id']}")

    admin_client.post("/api/auth/logout")
    login(admin_client, "np@test.local", "pw-123456")
    assert admin_client.delete(f"/api/system/nodes/{node['id']}/purge").status_code == 403


def test_admin_cannot_purge_others_personal_space(admin_client, db):
    """영구 삭제도 프라이버시 원칙: 남의 개인 공간은 관리자도 불가."""
    from app.bootstrap import create_user

    create_user(db, email="priv@test.local", password="pw-123456")
    db.commit()
    admin_client.post("/api/auth/logout")
    login(admin_client, "priv@test.local", "pw-123456")
    sp = personal_space(admin_client)
    node = upload(admin_client, f"/api/spaces/{sp['id']}/files", "비밀.txt").json()
    admin_client.delete(f"/api/nodes/{node['id']}")

    admin_client.post("/api/auth/logout")
    from tests.conftest import ADMIN_EMAIL, ADMIN_PASSWORD

    login(admin_client, ADMIN_EMAIL, ADMIN_PASSWORD)
    assert admin_client.delete(f"/api/system/nodes/{node['id']}/purge").status_code == 403


def test_stale_share_rows_cleaned_on_boot(app_factory):
    """만료·회수 90일 경과 링크는 기동 시 정리된다."""
    from datetime import timedelta

    from fastapi.testclient import TestClient

    from app.models import ShareLink, utcnow
    from tests.conftest import ADMIN_EMAIL, ADMIN_PASSWORD

    app = app_factory(ADMIN_EMAIL=ADMIN_EMAIL, ADMIN_PASSWORD=ADMIN_PASSWORD)
    with TestClient(app) as c:
        login(c, ADMIN_EMAIL, ADMIN_PASSWORD)
        sp = next(s for s in c.get("/api/spaces").json() if s["type"] == "personal")
        node = upload(c, f"/api/spaces/{sp['id']}/files", "s.txt").json()
        share = c.post(f"/api/nodes/{node['id']}/shares", json={}).json()

    SessionLocal = app.state.sessionmaker
    with SessionLocal() as db:
        row = db.get(ShareLink, share["id"])
        row.expires_at = utcnow() - timedelta(days=120)
        db.commit()

    # 같은 DB로 앱 재기동 → 정리 실행
    from app.config import get_settings

    get_settings.cache_clear()
    from app.main import create_app

    app2 = create_app()
    with app2.state.sessionmaker() as db:
        assert db.get(ShareLink, share["id"]) is None
