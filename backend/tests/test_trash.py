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


def test_trashed_folder_children_are_not_deep_linkable(admin_client):
    """폴더를 휴지통에 넣으면 그 안의 자식(직속·손자)도 딥링크로 접근 불가(404)여야 한다.

    soft_delete는 폴더(루트)만 deleted_at을 찍지만 get_node_checked가 조상 사슬의
    휴지통을 확인하므로, 자식 id를 직접 아는 요청도 404가 된다. 복원하면 다시 열린다
    (자식 자체는 계속 deleted_at=None이라 자기 휴지통엔 안 들어간다)."""
    sp = personal_space(admin_client)
    folder = admin_client.post(
        "/api/nodes", json={"space_id": sp["id"], "name": "비밀폴더"}
    ).json()
    sub = admin_client.post(
        "/api/nodes",
        json={"space_id": sp["id"], "parent_id": folder["id"], "name": "안쪽"},
    ).json()
    child = upload(
        admin_client, f"/api/nodes/{folder['id']}/files", "child.txt", b"secret"
    ).json()
    deep = upload(
        admin_client, f"/api/nodes/{sub['id']}/files", "deep.txt", b"deeper"
    ).json()

    # 삭제 전엔 자식 딥링크가 열린다
    assert admin_client.get(f"/api/files/{child['id']}").status_code == 200
    assert admin_client.get(f"/api/nodes/{deep['id']}/path").status_code == 200

    admin_client.delete(f"/api/nodes/{folder['id']}")  # 폴더만 soft delete

    # 직속·손자 파일 딥링크(열람·raw·경로 복원)가 모두 404
    for nid in (child["id"], deep["id"]):
        assert admin_client.get(f"/api/files/{nid}").status_code == 404
        assert admin_client.get(f"/api/files/{nid}/raw").status_code == 404
        assert admin_client.get(f"/api/nodes/{nid}/path").status_code == 404
    # 중간 폴더의 children 조회도 404
    assert admin_client.get(f"/api/nodes/{sub['id']}/children").status_code == 404
    # 자식은 스스로 삭제된 게 아니므로 휴지통 목록엔 폴더만 뜬다(자식은 안 뜸)
    trash_ids = {t["id"] for t in admin_client.get(f"/api/spaces/{sp['id']}/trash").json()}
    assert folder["id"] in trash_ids
    assert child["id"] not in trash_ids and deep["id"] not in trash_ids

    # 폴더를 복원하면 자식은 다시 접근 가능
    assert admin_client.post(f"/api/nodes/{folder['id']}/restore").status_code == 200
    assert admin_client.get(f"/api/files/{child['id']}").status_code == 200
    assert admin_client.get(f"/api/files/{deep['id']}").status_code == 200


def test_share_on_child_of_trashed_folder_is_gone(admin_client):
    """자식 파일에 만든 공유 링크는 그 부모 폴더가 휴지통에 들어가면 410이어야 한다.

    자식 자체는 deleted_at=None이라 resolve_share의 '자기-삭제' 검사만으론 통과되어
    비로그인 공개 링크로 유출됐다. 조상 휴지통 검사로 막고, 복원하면 다시 열린다."""
    sp = personal_space(admin_client)
    folder = admin_client.post(
        "/api/nodes", json={"space_id": sp["id"], "name": "공유상위"}
    ).json()
    child = upload(
        admin_client, f"/api/nodes/{folder['id']}/files", "링크대상.txt", b"leak"
    ).json()
    token = admin_client.post(f"/api/nodes/{child['id']}/shares", json={}).json()["token"]

    admin_client.post("/api/auth/logout")  # 공개(비로그인) 접근으로 확인
    assert admin_client.get(f"/s/{token}/download").status_code == 200  # 삭제 전엔 열림

    login(admin_client, ADMIN_EMAIL, ADMIN_PASSWORD)
    admin_client.delete(f"/api/nodes/{folder['id']}")  # 부모 폴더만 휴지통으로
    admin_client.post("/api/auth/logout")
    assert admin_client.get(f"/s/{token}/download").status_code == 410
    assert admin_client.get(f"/s/{token}/raw").status_code == 410

    # 복원하면 공유가 다시 유효
    login(admin_client, ADMIN_EMAIL, ADMIN_PASSWORD)
    admin_client.post(f"/api/nodes/{folder['id']}/restore")
    admin_client.post("/api/auth/logout")
    assert admin_client.get(f"/s/{token}/download").status_code == 200


def test_restore_folder_keeps_independently_trashed_child_hidden(admin_client):
    """중첩 휴지통 정합성: 자식을 먼저 휴지통에 넣고 부모 폴더도 넣은 뒤 부모만 복원하면,
    따로 버려진 자식은 여전히 접근 불가(자식 자신의 deleted_at 유지)이고 복원 가능해야 한다."""
    sp = personal_space(admin_client)
    folder = admin_client.post(
        "/api/nodes", json={"space_id": sp["id"], "name": "상위"}
    ).json()
    child = upload(
        admin_client, f"/api/nodes/{folder['id']}/files", "따로삭제.txt"
    ).json()

    admin_client.delete(f"/api/nodes/{child['id']}")  # 자식 먼저 휴지통
    admin_client.delete(f"/api/nodes/{folder['id']}")  # 부모도 휴지통
    admin_client.post(f"/api/nodes/{folder['id']}/restore")  # 부모만 복원

    # 자식은 스스로 휴지통에 있으므로 여전히 404, 그리고 자기 휴지통 목록에 남아 복원 가능
    assert admin_client.get(f"/api/files/{child['id']}").status_code == 404
    trash_ids = {t["id"] for t in admin_client.get(f"/api/spaces/{sp['id']}/trash").json()}
    assert child["id"] in trash_ids
    assert admin_client.post(f"/api/nodes/{child['id']}/restore").status_code == 200
    assert admin_client.get(f"/api/files/{child['id']}").status_code == 200


def test_trashed_folder_children_hidden_from_all_listings(admin_client):
    """휴지통에 든 폴더의 자식은 목록 API 어디에도 노출되지 않아야 한다 —
    사이드바 파일 트리(tree)·폴더 트리(folders)·검색(search: 이름·내용)·
    즐겨찾기(favorites)·최근 열람(recent). 복원하면 다시 보인다."""
    sp = personal_space(admin_client)
    folder = admin_client.post(
        "/api/nodes", json={"space_id": sp["id"], "name": "F숨김"}
    ).json()
    sub = admin_client.post(
        "/api/nodes",
        json={"space_id": sp["id"], "parent_id": folder["id"], "name": "Sub숨김"},
    ).json()
    child = upload(
        admin_client, f"/api/nodes/{folder['id']}/files", "child_찾아줘.txt", b"NEEDLE"
    ).json()
    upload(admin_client, f"/api/nodes/{sub['id']}/files", "deep_찾아줘.txt", b"DEEP")

    # 즐겨찾기·최근열람 등록(삭제 전)
    admin_client.post(f"/api/nodes/{child['id']}/favorite")
    admin_client.post(f"/api/nodes/{child['id']}/view")

    def names(rows):
        return {r.get("name") for r in rows}

    # 삭제 전엔 트리에 보인다(정상)
    assert "child_찾아줘.txt" in names(admin_client.get(f"/api/spaces/{sp['id']}/tree").json())

    admin_client.delete(f"/api/nodes/{folder['id']}")  # 폴더만 soft delete

    listings = {
        "tree": names(admin_client.get(f"/api/spaces/{sp['id']}/tree").json()),
        "folders": names(admin_client.get(f"/api/spaces/{sp['id']}/folders").json()),
        "search-name": names(
            admin_client.get(f"/api/spaces/{sp['id']}/search", params={"q": "찾아줘"}).json()
        ),
        "search-content": names(
            admin_client.get(f"/api/spaces/{sp['id']}/search", params={"q": "NEEDLE"}).json()
        ),
        "favorites": names(admin_client.get("/api/favorites").json()),
        "recent": names(admin_client.get("/api/recent").json()),
    }
    for label, got in listings.items():
        assert "child_찾아줘.txt" not in got, f"{label}에 휴지통 폴더의 자식이 노출됨"
        assert "deep_찾아줘.txt" not in got, f"{label}에 휴지통 폴더의 손자가 노출됨"
    # 하위 폴더(Sub)도 트리·폴더 목록에서 사라져야 한다
    assert "Sub숨김" not in listings["folders"] and "Sub숨김" not in listings["tree"]

    # 복원하면 자식이 목록에 다시 나타난다
    admin_client.post(f"/api/nodes/{folder['id']}/restore")
    assert "child_찾아줘.txt" in names(admin_client.get(f"/api/spaces/{sp['id']}/tree").json())
    assert "child_찾아줘.txt" in names(admin_client.get("/api/favorites").json())


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
