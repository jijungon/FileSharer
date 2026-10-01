import io
import tarfile
from datetime import timedelta

from app.models import ShareLink, utcnow
from tests.conftest import ADMIN_EMAIL, ADMIN_PASSWORD, login


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


def test_shared_html_is_sandboxed(admin_client):
    """공유된 HTML 은 **앱 오리진에서 실행되면 안 된다.**

    /s/<token>/raw 는 비로그인으로 열리는 주소다. 누가 이 주소를 주소창에 바로 열면
    업로드된 HTML 이 file.rgrg.im 에서 그대로 돈다 — 세션 쿠키는 HttpOnly 라도 같은
    오리진으로 인증된 API 를 부를 수 있으니 그 사람 행세가 된다. 공유 링크는 사외에
    건네라고 만든 것이라 더 위험하다.

    앱 안(/api/files/{id}/raw)에는 이 방어가 있었는데 **공유 쪽만 빠져 있었다.**
    """
    sp = personal_space(admin_client)
    # 업로더가 보낸 mime 이 일반적(octet-stream)이어도 확장자로 html 임이 드러난다 —
    # 그 경로까지 막혀 있어야 한다.
    node = admin_client.post(
        f"/api/spaces/{sp['id']}/files",
        files={
            "file": (
                "page.html",
                io.BytesIO(b"<h1>hi</h1><script>alert(1)</script>"),
                "application/octet-stream",
            )
        },
    ).json()
    token = admin_client.post(f"/api/nodes/{node['id']}/shares", json={}).json()["token"]
    admin_client.post("/api/auth/logout")

    res = admin_client.get(f"/s/{token}/raw")
    assert res.status_code == 200
    assert res.headers["content-type"].startswith("text/html")
    assert res.headers["Content-Security-Policy"] == "sandbox"
    assert res.headers["X-Content-Type-Options"] == "nosniff"


def test_shared_video_gets_real_media_type(admin_client):
    """확장자로 형식을 되짚어 준다 — 안 그러면 공유 페이지에서 영상이 재생되지 않는다.

    업로더가 보낸 mime 이 비거나 octet-stream 인 경우가 흔하다(브라우저·CLI 마다 다르다).
    """
    sp = personal_space(admin_client)
    node = admin_client.post(
        f"/api/spaces/{sp['id']}/files",
        files={
            "file": ("clip.mp4", io.BytesIO(b"\x00\x00\x00 ftypmp42"), "application/octet-stream")
        },
    ).json()
    token = admin_client.post(f"/api/nodes/{node['id']}/shares", json={}).json()["token"]
    admin_client.post("/api/auth/logout")

    res = admin_client.get(f"/s/{token}/raw")
    assert res.headers["content-type"].startswith("video/mp4")


def test_share_office_preview_needs_a_valid_link(admin_client):
    """공유된 오피스 문서는 PDF 로 볼 수 있다 — 단, 링크 규칙은 그대로 지킨다.

    변환 자체(LibreOffice)는 이 환경에 없을 수 있으므로 **권한·형식 판정만** 본다.
    오피스가 아니면 400, 회수된 링크면 410 — 즉 미리보기가 규칙을 우회하지 않는다.
    """
    sp = personal_space(admin_client)
    txt = upload(admin_client, f"/api/spaces/{sp['id']}/files", "메모.txt", b"x").json()
    token = admin_client.post(f"/api/nodes/{txt['id']}/shares", json={}).json()["token"]
    admin_client.post("/api/auth/logout")

    # 오피스가 아니면 미리보기 대상이 아니다
    assert admin_client.get(f"/s/{token}/preview.pdf").status_code == 400
    # 영상도 마찬가지
    assert admin_client.get(f"/s/{token}/preview.mp4").status_code == 400


def test_share_preview_respects_revoke_and_password(admin_client):
    """미리보기 주소가 **뒷문이 되면 안 된다** — 회수·비밀번호를 그대로 지킨다."""
    sp = personal_space(admin_client)
    node = upload(admin_client, f"/api/spaces/{sp['id']}/files", "발표.pptx", b"x").json()
    res = admin_client.post(
        f"/api/nodes/{node['id']}/shares", json={"password": "knock-knock"}
    ).json()
    token, share_id = res["token"], res["id"]
    admin_client.post("/api/auth/logout")

    # 비밀번호 없이는 미리보기도 막힌다
    assert admin_client.get(f"/s/{token}/preview.pdf").status_code == 401

    # 회수하면 미리보기도 함께 죽는다
    login(admin_client, ADMIN_EMAIL, ADMIN_PASSWORD)
    admin_client.delete(f"/api/shares/{share_id}")
    admin_client.post("/api/auth/logout")
    assert admin_client.get(f"/s/{token}/preview.pdf", auth=("", "knock-knock")).status_code == 410


def test_non_ascii_password_travels_only_via_basic_auth(admin_client):
    """한글 비밀번호는 Basic 으로만 지나간다 — 공유 화면이 이 경로에 기대고 있다.

    HTTP 헤더 값은 Latin-1 만 담을 수 있어서 X-Share-Password 로는 한글을 실어 나를 수 없다.
    브라우저는 보내기도 전에 TypeError 를 던지고, 억지로 밀어 넣어도 서버엔 깨진 값이 온다.
    그래서 프런트(frontend/src/lib/sharepw.ts)가 Basic(base64 of UTF-8)으로 감싸 보낸다.
    여기 Basic 분기를 없애거나 .decode() 를 latin-1 로 바꾸면 **화면이 조용히 깨진다.**
    """
    _, res = make_file_share(admin_client, b"secret", password="한글비밀번호")
    token = res.json()["token"]
    admin_client.post("/api/auth/logout")

    assert admin_client.get(f"/s/{token}/download").status_code == 401
    assert admin_client.get(f"/s/{token}/download", auth=("", "틀린비번")).status_code == 401

    ok = admin_client.get(f"/s/{token}/download", auth=("", "한글비밀번호"))
    assert ok.status_code == 200 and ok.content == b"secret"


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


def test_share_url_uses_frontend_url_when_set(app_factory):
    """dev처럼 FRONTEND_URL이 설정되면 공유 URL이 그 오리진(프론트)을 쓴다."""
    from fastapi.testclient import TestClient

    from tests.conftest import ADMIN_EMAIL, ADMIN_PASSWORD

    app = app_factory(
        ADMIN_EMAIL=ADMIN_EMAIL,
        ADMIN_PASSWORD=ADMIN_PASSWORD,
        BASE_URL="http://localhost:8642",
        FRONTEND_URL="http://localhost:5173",
    )
    with TestClient(app) as c:
        login(c, ADMIN_EMAIL, ADMIN_PASSWORD)
        sp = personal_space(c)
        node = upload(c, f"/api/spaces/{sp['id']}/files", "f.txt").json()
        body = c.post(f"/api/nodes/{node['id']}/shares", json={}).json()
        assert body["url"].startswith("http://localhost:5173/s/")
        assert body["get_command"].startswith("curl -fsSL http://localhost:5173/s/")


def test_range_continuation_does_not_consume_download(admin_client):
    """Range 이어받기 조각(bytes=N-, N>0)은 다운로드 횟수를 소비하지 않는다."""
    _, res = make_file_share(admin_client, b"0123456789", max_downloads=2)
    token = res.json()["token"]
    admin_client.post("/api/auth/logout")

    ok = (200, 206)
    # ① 전체 다운로드 1회 → 카운트 1
    assert admin_client.get(f"/s/{token}/download").status_code == 200
    # ② 이어받기 조각(bytes=3-) 여러 번 → 카운트 안 됨(남은 1회 유지)
    for _ in range(5):
        assert admin_client.get(
            f"/s/{token}/download", headers={"Range": "bytes=3-"}
        ).status_code in ok
    # ③ bytes=0- (새 다운로드 시작)은 카운트 → 2회째, 한도 소진
    assert admin_client.get(f"/s/{token}/download", headers={"Range": "bytes=0-"}).status_code in ok
    # ④ 한도(2) 소진 후 전체 다운로드는 410
    assert admin_client.get(f"/s/{token}/download").status_code == 410
    # ⑤ 하지만 이어받기 조각은 진행 중 다운로드 보호를 위해 여전히 통과
    assert admin_client.get(
        f"/s/{token}/download", headers={"Range": "bytes=5-"}
    ).status_code in ok
