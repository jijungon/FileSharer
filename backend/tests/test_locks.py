import io
from datetime import timedelta

from app.bootstrap import create_user
from app.models import EditLock, utcnow
from tests.conftest import ADMIN_EMAIL, ADMIN_PASSWORD, login


def spaces_of(client):
    return {s["type"]: s for s in client.get("/api/spaces").json()}


def make_user(db, email, name=""):
    create_user(db, email=email, password="pw-123456", name=name)
    db.commit()


def org_md(client, name="doc.md"):
    """org(전체) 공간에 MD 하나 올리고 노드 반환 — 로그인 사용자 누구나 접근 가능."""
    oid = spaces_of(client)["org"]["id"]
    return client.post(
        f"/api/spaces/{oid}/files",
        files={"file": (name, io.BytesIO(b"hello"), "text/markdown")},
    ).json()


def test_acquire_blocks_others(admin_client, db):
    """A가 잠그면 B는 held_by_me=false + holder=A(관리자 이름). GET 상태도 locked=true."""
    make_user(db, "lock-b@test.local")
    node = org_md(admin_client)

    r = admin_client.post(f"/api/nodes/{node['id']}/lock").json()
    assert r == {"held_by_me": True, "holder": ""}

    admin_client.post("/api/auth/logout")
    login(admin_client, "lock-b@test.local", "pw-123456")
    r = admin_client.post(f"/api/nodes/{node['id']}/lock").json()
    assert r["held_by_me"] is False
    assert r["holder"] == "admin"  # 닉네임 = 이메일 @ 앞부분(admin@test.local → admin)
    s = admin_client.get(f"/api/nodes/{node['id']}/lock").json()
    assert s == {"locked": True, "held_by_me": False, "holder": "admin"}


def test_release_frees_lock(admin_client, db):
    """A가 해제하면 B가 획득 가능."""
    make_user(db, "lock-c@test.local")
    node = org_md(admin_client)
    admin_client.post(f"/api/nodes/{node['id']}/lock")
    assert admin_client.post(f"/api/nodes/{node['id']}/lock/release").json() == {"released": True}

    admin_client.post("/api/auth/logout")
    login(admin_client, "lock-c@test.local", "pw-123456")
    assert admin_client.post(f"/api/nodes/{node['id']}/lock").json()["held_by_me"] is True


def test_stale_lock_taken_over(admin_client, db):
    """하트비트가 TTL 넘게 끊긴 잠금은 만료 → 다른 사람이 인수."""
    make_user(db, "lock-d@test.local")
    node = org_md(admin_client)
    admin_client.post(f"/api/nodes/{node['id']}/lock")

    lock = db.get(EditLock, node["id"])
    lock.heartbeat_at = utcnow() - timedelta(minutes=5)  # 오래된 하트비트 → 만료
    db.commit()

    admin_client.post("/api/auth/logout")
    login(admin_client, "lock-d@test.local", "pw-123456")
    assert admin_client.get(f"/api/nodes/{node['id']}/lock").json()["locked"] is False
    assert admin_client.post(f"/api/nodes/{node['id']}/lock").json()["held_by_me"] is True


def test_heartbeat_keeps_my_lock(admin_client):
    """같은 사용자가 다시 호출(하트비트)해도 계속 내 잠금."""
    node = org_md(admin_client)
    assert admin_client.post(f"/api/nodes/{node['id']}/lock").json()["held_by_me"] is True
    assert admin_client.post(f"/api/nodes/{node['id']}/lock").json()["held_by_me"] is True


def test_lock_denied_without_access(admin_client, db):
    """프라이버시: 남의 개인공간 항목은 잠글 수 없다(403/404)."""
    make_user(db, "lock-e@test.local")
    admin_client.post("/api/auth/logout")
    login(admin_client, "lock-e@test.local", "pw-123456")
    opid = spaces_of(admin_client)["personal"]["id"]
    node = admin_client.post(
        f"/api/spaces/{opid}/files",
        files={"file": ("secret.md", io.BytesIO(b"x"), "text/markdown")},
    ).json()

    admin_client.post("/api/auth/logout")
    login(admin_client, ADMIN_EMAIL, ADMIN_PASSWORD)
    assert admin_client.post(f"/api/nodes/{node['id']}/lock").status_code in (403, 404)


def test_holder_shown_as_email_nickname(admin_client, db):
    """holder는 이메일 @ 앞부분(닉네임)으로 표시된다 — 점(.) 포함 로컬파트도 그대로."""
    make_user(db, "alice.kim@corp.example", name="앨리스")  # name 있어도 닉네임은 이메일 기준
    node = org_md(admin_client)

    admin_client.post("/api/auth/logout")
    login(admin_client, "alice.kim@corp.example", "pw-123456")
    admin_client.post(f"/api/nodes/{node['id']}/lock")  # 앨리스가 잠금

    admin_client.post("/api/auth/logout")
    login(admin_client, ADMIN_EMAIL, ADMIN_PASSWORD)
    s = admin_client.get(f"/api/nodes/{node['id']}/lock").json()
    assert s["holder"] == "alice.kim"  # @ 앞부분, name('앨리스') 아님


def test_email_nickname_helper():
    from app.models import email_nickname

    assert email_nickname("joji@parametacorp.com") == "joji"
    assert email_nickname("a.b.c@x.io") == "a.b.c"
    assert email_nickname("noatsign") == "noatsign"  # @ 없으면 원문
