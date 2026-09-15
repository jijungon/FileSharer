import io
from datetime import timedelta

from tests.conftest import ADMIN_EMAIL, ADMIN_PASSWORD, login


def upload(client, url, name, content=b"hello"):
    return client.post(url, files={"file": (name, io.BytesIO(content), "text/plain")})


def personal_space(client):
    return next(s for s in client.get("/api/spaces").json() if s["type"] == "personal")


def _sweep(client, days=2) -> int:
    from app.config import get_settings
    from app.services.storage import build_storage
    from app.services.trash import purge_expired

    SessionLocal = client.app.state.sessionmaker
    with SessionLocal() as db:
        return purge_expired(db, build_storage(get_settings()), days)


def test_expired_trash_purged_with_blob(admin_client):
    """보존기간(2일) 지난 휴지통 항목은 서브트리·blob·행까지 완전삭제된다."""
    from app.config import get_settings
    from app.models import Node, utcnow
    from app.services.storage import build_storage

    sp = personal_space(admin_client)
    folder = admin_client.post(
        "/api/nodes", json={"space_id": sp["id"], "name": "오래된"}
    ).json()
    node = upload(admin_client, f"/api/nodes/{folder['id']}/files", "old.txt", b"bye").json()
    admin_client.delete(f"/api/nodes/{folder['id']}")  # soft delete

    SessionLocal = admin_client.app.state.sessionmaker
    with SessionLocal() as db:
        key = db.get(Node, node["id"]).storage_key
        db.get(Node, folder["id"]).deleted_at = utcnow() - timedelta(days=3)  # 3일 전
        db.commit()
    assert build_storage(get_settings()).exists(key) is True

    assert _sweep(admin_client, 2) == 2  # 폴더 + 파일

    assert admin_client.get(f"/api/spaces/{sp['id']}/trash").json() == []
    with SessionLocal() as db:
        assert db.get(Node, folder["id"]) is None
        assert db.get(Node, node["id"]) is None
    assert build_storage(get_settings()).exists(key) is False  # blob도 제거됨


def test_recent_trash_is_kept(admin_client):
    """방금 지운 항목은 보존기간 내라 유지된다."""
    sp = personal_space(admin_client)
    node = upload(admin_client, f"/api/spaces/{sp['id']}/files", "recent.txt").json()
    admin_client.delete(f"/api/nodes/{node['id']}")  # 오늘 삭제

    assert _sweep(admin_client, 2) == 0
    trash = admin_client.get(f"/api/spaces/{sp['id']}/trash").json()
    assert any(t["id"] == node["id"] for t in trash)


def test_trash_listing_exposes_purge_schedule(admin_client):
    """휴지통 목록은 삭제시각과 자동 완전삭제 예정시각(= 삭제시각 + 보존기간)을 포함한다."""
    from datetime import datetime, timedelta

    from app.config import get_settings

    sp = personal_space(admin_client)
    node = upload(admin_client, f"/api/spaces/{sp['id']}/files", "예정.txt").json()
    admin_client.delete(f"/api/nodes/{node['id']}")

    row = next(t for t in admin_client.get(f"/api/spaces/{sp['id']}/trash").json())
    assert row["deleted_at"] and row["purge_at"]
    deleted = datetime.fromisoformat(row["deleted_at"])
    purge = datetime.fromisoformat(row["purge_at"])
    assert purge - deleted == timedelta(days=get_settings().trash_retention_days)


def test_trash_swept_on_app_start(app_factory):
    """앱 기동(lifespan)에서 보존기간 지난 휴지통이 자동 정리된다(스위퍼 배선 검증)."""
    from fastapi.testclient import TestClient

    from app.models import Node, utcnow

    app = app_factory(ADMIN_EMAIL=ADMIN_EMAIL, ADMIN_PASSWORD=ADMIN_PASSWORD)
    with TestClient(app) as c:
        login(c, ADMIN_EMAIL, ADMIN_PASSWORD)
        sp = personal_space(c)
        node = upload(c, f"/api/spaces/{sp['id']}/files", "old.txt").json()
        c.delete(f"/api/nodes/{node['id']}")

    SessionLocal = app.state.sessionmaker
    with SessionLocal() as db:
        # 기본 보존기간(7일)보다 확실히 과거로 back-date → 기동 스위프가 purge
        db.get(Node, node["id"]).deleted_at = utcnow() - timedelta(days=8)
        db.commit()

    # 같은 DB로 재기동 → lifespan startup 스위프가 purge
    from app.config import get_settings

    get_settings.cache_clear()
    from app.main import create_app

    app2 = create_app()
    with TestClient(app2):  # 컨텍스트 진입 = lifespan 실행
        pass
    with app2.state.sessionmaker() as db:
        assert db.get(Node, node["id"]) is None


def test_user_purges_own_trashed_node_and_blob(admin_client):
    """휴지통 항목을 본인이 영구삭제 → DB행+blob 제거. 휴지통 아닌 건 400."""
    from app.config import get_settings
    from app.models import Node
    from app.services.storage import build_storage

    sp = personal_space(admin_client)
    node = upload(admin_client, f"/api/spaces/{sp['id']}/files", "지울것.txt", b"bye").json()
    live = upload(admin_client, f"/api/spaces/{sp['id']}/files", "살아있는것.txt").json()
    admin_client.delete(f"/api/nodes/{node['id']}")  # 휴지통으로

    SessionLocal = admin_client.app.state.sessionmaker
    with SessionLocal() as db:
        key = db.get(Node, node["id"]).storage_key

    # 휴지통에 없는 항목 purge는 400
    assert admin_client.delete(f"/api/nodes/{live['id']}/purge").status_code == 400
    # 휴지통 항목 영구삭제
    res = admin_client.delete(f"/api/nodes/{node['id']}/purge")
    assert res.status_code == 200 and res.json()["removed"] == 1
    with SessionLocal() as db:
        assert db.get(Node, node["id"]) is None
    assert build_storage(get_settings()).exists(key) is False


def test_user_cannot_purge_in_others_personal_space(admin_client, db):
    """프라이버시: 남의 개인공간 휴지통 항목은 영구삭제 불가."""
    from app.bootstrap import create_user

    create_user(db, email="other@test.local", password="pw-123456")
    db.commit()
    admin_client.post("/api/auth/logout")
    login(admin_client, "other@test.local", "pw-123456")
    sp = personal_space(admin_client)
    node = upload(admin_client, f"/api/spaces/{sp['id']}/files", "남의것.txt").json()
    admin_client.delete(f"/api/nodes/{node['id']}")

    admin_client.post("/api/auth/logout")
    login(admin_client, ADMIN_EMAIL, ADMIN_PASSWORD)
    assert admin_client.delete(f"/api/nodes/{node['id']}/purge").status_code in (403, 404)
