import io
import tarfile
from datetime import timedelta

from app.models import ShareLink, utcnow
from tests.conftest import login


def upload(client, url, name, content=b"hello"):
    return client.post(url, files={"file": (name, io.BytesIO(content), "text/plain")})


def personal_space(client):
    return next(s for s in client.get("/api/spaces").json() if s["type"] == "personal")


def make_file_share(admin_client, content=b"share me", **opts):
    sp = personal_space(admin_client)
    node = upload(admin_client, f"/api/spaces/{sp['id']}/files", "공유.txt", content).json()
    share = admin_client.post(f"/api/nodes/{node['id']}/shares", json=opts)
    return node, share


def test_create_and_download_without_login(admin_client, client):
    node, res = make_file_share(admin_client, b"public content")
    assert res.status_code == 201
    body = res.json()
    assert body["token"] and "/s/" in body["url"]

    admin_client.post("/api/auth/logout")  # 비로그인 상태로 전환
    dl = admin_client.get(f"/s/{body['token']}/download")
    assert dl.status_code == 200
    assert dl.content == b"public content"
    assert "X-Checksum-SHA256" in dl.headers

    meta = admin_client.get(f"/s/{body['token']}/meta").json()
    assert meta["name"] == "공유.txt"
    assert meta["protected"] is False


def test_cli_content_negotiation_redirects_to_download(admin_client):
    _, res = make_file_share(admin_client)
    token = res.json()["token"]
    admin_client.post("/api/auth/logout")
    r = admin_client.get(f"/s/{token}", headers={"Accept": "*/*"}, follow_redirects=False)
    assert r.status_code == 302
    assert r.headers["location"].endswith("/download")


def test_expired_link_is_gone(admin_client, db):
    _, res = make_file_share(admin_client)
    share_id = res.json()["id"]
    token = res.json()["token"]
    share = db.get(ShareLink, share_id)
    share.expires_at = utcnow() - timedelta(days=1)
    db.commit()

    assert admin_client.get(f"/s/{token}/download").status_code == 410


def test_revoked_link_is_gone(admin_client):
    _, res = make_file_share(admin_client)
    body = res.json()
    assert admin_client.delete(f"/api/shares/{body['id']}").status_code == 200
    assert admin_client.get(f"/s/{body['token']}/download").status_code == 410


def test_days_over_max_rejected(admin_client):
    _, res = make_file_share(admin_client, days=99)
    assert res.status_code == 422


def test_password_protected_flow(admin_client):
    _, res = make_file_share(admin_client, b"secret", password="knock-knock")
    token = res.json()["token"]
    admin_client.post("/api/auth/logout")

    no_pw = admin_client.get(f"/s/{token}/download")
    assert no_pw.status_code == 401
    assert "WWW-Authenticate" in no_pw.headers

    wrong = admin_client.get(f"/s/{token}/download", auth=("", "wrong"))
    assert wrong.status_code == 401

    basic = admin_client.get(f"/s/{token}/download", auth=("", "knock-knock"))
    assert basic.status_code == 200 and basic.content == b"secret"

    header = admin_client.get(
        f"/s/{token}/download", headers={"X-Share-Password": "knock-knock"}
    )
    assert header.status_code == 200


def test_max_downloads_enforced(admin_client):
    _, res = make_file_share(admin_client, max_downloads=2)
    token = res.json()["token"]
    admin_client.post("/api/auth/logout")

    assert admin_client.get(f"/s/{token}/download").status_code == 200
    assert admin_client.get(f"/s/{token}/download").status_code == 200
    assert admin_client.get(f"/s/{token}/download").status_code == 410
    # 미리보기(raw)는 카운트를 쓰지 않는다
    assert admin_client.get(f"/s/{token}/raw").status_code == 200


def test_folder_share_tar(admin_client):
    sp = personal_space(admin_client)
    folder = admin_client.post(
        "/api/nodes", json={"space_id": sp["id"], "name": "묶음"}
    ).json()
    upload(admin_client, f"/api/nodes/{folder['id']}/files", "안내.md", b"# hi")
    res = admin_client.post(f"/api/nodes/{folder['id']}/shares", json={})
    token = res.json()["token"]
    admin_client.post("/api/auth/logout")

    tar_res = admin_client.get(f"/s/{token}/tar")
    assert tar_res.status_code == 200
    with tarfile.open(fileobj=io.BytesIO(tar_res.content), mode="r:gz") as tar:
        assert sorted(tar.getnames()) == ["묶음", "묶음/안내.md"]

    # /download는 폴더면 tar로 302
    r = admin_client.get(f"/s/{token}/download", follow_redirects=False)
    assert r.status_code == 302 and r.headers["location"].endswith("/tar")


def test_share_of_deleted_node_is_gone(admin_client):
    node, res = make_file_share(admin_client)
    token = res.json()["token"]
    admin_client.delete(f"/api/nodes/{node['id']}")
    assert admin_client.get(f"/s/{token}/download").status_code == 410


def test_share_requires_space_permission(admin_client, db):
    from app.bootstrap import create_user

    create_user(db, email="other@test.local", password="pw-123456")
    db.commit()
    node, _ = make_file_share(admin_client)

    admin_client.post("/api/auth/logout")
    login(admin_client, "other@test.local", "pw-123456")
    res = admin_client.post(f"/api/nodes/{node['id']}/shares", json={})
    assert res.status_code == 403
