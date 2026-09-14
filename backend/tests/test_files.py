import io
import tarfile

from tests.conftest import login


def upload(client, url, name, content=b"hello", mime="text/plain"):
    return client.post(url, files={"file": (name, io.BytesIO(content), mime)})


def setup_people(admin_client, db):
    """admin + A(팀원) + B(비팀원) + 개발팀. 반환: (a_spaces 함수, ids)."""
    a = admin_client.post(
        "/api/users", json={"email": "a@test.local", "password": "pw-123456"}
    ).json()
    b = admin_client.post(
        "/api/users", json={"email": "b@test.local", "password": "pw-123456"}
    ).json()
    team = admin_client.post("/api/teams", json={"name": "개발팀"}).json()
    admin_client.post(f"/api/teams/{team['id']}/members", json={"user_id": a["id"]})
    return a, b, team


def spaces_of(client):
    return {s["type"]: s for s in client.get("/api/spaces").json()}


def as_user(client, email):
    client.post("/api/auth/logout")
    assert login(client, email, "pw-123456").status_code == 200
    return spaces_of(client)


# ---------- 업로드/다운로드 왕복 ----------


def test_upload_download_roundtrip(admin_client):
    sp = spaces_of(admin_client)
    content = "한글 내용입니다 ✓".encode()
    node = upload(
        admin_client, f"/api/spaces/{sp['personal']['id']}/files", "노트.md", content
    ).json()
    assert node["type"] == "file"
    assert node["size"] == len(content)

    res = admin_client.get(f"/api/files/{node['id']}")
    assert res.status_code == 200
    assert res.content == content
    assert "X-Checksum-SHA256" in res.headers
    assert "attachment" in res.headers["content-disposition"]

    raw = admin_client.get(f"/api/files/{node['id']}/raw")
    assert raw.status_code == 200
    assert "inline" in raw.headers["content-disposition"]


def test_raw_reinfers_content_type_from_extension(admin_client):
    """브라우저가 generic mime으로 올려도 raw는 확장자로 재추론해 렌더 가능하게 한다."""
    sp = spaces_of(admin_client)
    base = f"/api/spaces/{sp['personal']['id']}/files"
    mp4 = upload(admin_client, base, "클립.mp4", b"\x00\x00\x00", "application/octet-stream").json()
    raw = admin_client.get(f"/api/files/{mp4['id']}/raw")
    assert raw.headers["content-type"].startswith("video/mp4")


def test_raw_html_is_sandboxed(admin_client):
    """업로드된 HTML은 앱 오리진에서 스크립트가 실행되지 않도록 sandbox로 내려준다."""
    sp = spaces_of(admin_client)
    base = f"/api/spaces/{sp['personal']['id']}/files"
    html = upload(
        admin_client, base, "page.html", b"<script>alert(1)</script>", "text/html"
    ).json()
    raw = admin_client.get(f"/api/files/{html['id']}/raw")
    assert raw.headers["content-type"].startswith("text/html")
    assert raw.headers.get("content-security-policy") == "sandbox"
    assert raw.headers.get("x-content-type-options") == "nosniff"


def test_upload_size_limit(app_factory):
    from fastapi.testclient import TestClient

    from tests.conftest import ADMIN_EMAIL, ADMIN_PASSWORD

    app = app_factory(
        ADMIN_EMAIL=ADMIN_EMAIL, ADMIN_PASSWORD=ADMIN_PASSWORD, MAX_UPLOAD_MB="1"
    )
    with TestClient(app) as c:
        login(c, ADMIN_EMAIL, ADMIN_PASSWORD)
        sp = spaces_of(c)
        big = b"x" * (1024 * 1024 + 10)
        res = upload(c, f"/api/spaces/{sp['personal']['id']}/files", "big.bin", big)
        assert res.status_code == 413


def test_nfd_filename_normalized_and_traversal_blocked(admin_client):
    sp = spaces_of(admin_client)
    nfd_name = "한글파일.md".encode().decode("utf-8")
    import unicodedata

    nfd = unicodedata.normalize("NFD", nfd_name)
    node = upload(admin_client, f"/api/spaces/{sp['personal']['id']}/files", nfd).json()
    assert node["name"] == "한글파일.md"  # NFC

    tricky = upload(
        admin_client, f"/api/spaces/{sp['personal']['id']}/files", "../../etc/passwd"
    ).json()
    assert tricky["name"] == "passwd"


def test_duplicate_names_get_suffix(admin_client):
    sp = spaces_of(admin_client)
    url = f"/api/spaces/{sp['personal']['id']}/files"
    first = upload(admin_client, url, "dup.txt").json()
    second = upload(admin_client, url, "dup.txt").json()
    assert first["name"] == "dup.txt"
    assert second["name"] == "dup (2).txt"


# ---------- 트리 ----------


def test_folder_tree_and_listing(admin_client):
    sp = spaces_of(admin_client)
    pid = sp["personal"]["id"]
    folder = admin_client.post(
        "/api/nodes", json={"space_id": pid, "name": "문서"}
    ).json()
    sub = admin_client.post(
        "/api/nodes", json={"space_id": pid, "parent_id": folder["id"], "name": "하위"}
    ).json()
    upload(admin_client, f"/api/nodes/{folder['id']}/files", "a.txt")

    root = admin_client.get(f"/api/spaces/{pid}/children").json()
    assert [n["name"] for n in root] == ["문서"]

    children = admin_client.get(f"/api/nodes/{folder['id']}/children").json()
    assert [n["name"] for n in children] == ["하위", "a.txt"]  # 폴더 먼저
    assert sub["parent_id"] == folder["id"]


# ---------- 권한 매트릭스 ----------


def test_personal_space_is_private_even_from_admin(admin_client, db):
    a, _, _ = setup_people(admin_client, db)
    a_spaces = as_user(admin_client, "a@test.local")
    node = upload(
        admin_client, f"/api/spaces/{a_spaces['personal']['id']}/files", "비밀.txt"
    ).json()

    # 관리자도 남의 개인 공간은 403 (프라이버시 원칙)
    as_user(admin_client, "b@test.local")
    assert admin_client.get(f"/api/files/{node['id']}").status_code == 403

    admin_client.post("/api/auth/logout")
    from tests.conftest import ADMIN_EMAIL, ADMIN_PASSWORD

    login(admin_client, ADMIN_EMAIL, ADMIN_PASSWORD)
    assert admin_client.get(f"/api/files/{node['id']}").status_code == 403
    assert admin_client.get(f"/api/spaces/{a_spaces['personal']['id']}/children").status_code == 403


def test_team_space_member_only(admin_client, db):
    setup_people(admin_client, db)
    a_spaces = as_user(admin_client, "a@test.local")
    node = upload(
        admin_client, f"/api/spaces/{a_spaces['team']['id']}/files", "팀문서.md"
    ).json()
    assert admin_client.get(f"/api/files/{node['id']}").status_code == 200

    as_user(admin_client, "b@test.local")  # 비팀원
    assert admin_client.get(f"/api/files/{node['id']}").status_code == 403


def test_org_space_any_logged_in_user(admin_client, db):
    setup_people(admin_client, db)
    sp = spaces_of(admin_client)
    node = upload(admin_client, f"/api/spaces/{sp['org']['id']}/files", "공지.md").json()

    as_user(admin_client, "b@test.local")
    assert admin_client.get(f"/api/files/{node['id']}").status_code == 200


def test_unauthenticated_gets_401(client):
    assert client.get("/api/spaces").status_code == 401
    assert client.post("/api/nodes", json={"space_id": "x", "name": "n"}).status_code == 401


# ---------- 이동 ----------


def test_move_into_own_descendant_blocked(admin_client):
    sp = spaces_of(admin_client)
    pid = sp["personal"]["id"]
    top = admin_client.post("/api/nodes", json={"space_id": pid, "name": "상위"}).json()
    child = admin_client.post(
        "/api/nodes", json={"space_id": pid, "parent_id": top["id"], "name": "하위"}
    ).json()
    res = admin_client.patch(
        f"/api/nodes/{top['id']}", json={"move": True, "parent_id": child["id"]}
    )
    assert res.status_code == 400


def test_move_between_spaces_requires_both_writable(admin_client, db):
    setup_people(admin_client, db)
    b_spaces = as_user(admin_client, "b@test.local")
    node = upload(
        admin_client, f"/api/spaces/{b_spaces['personal']['id']}/files", "이동.txt"
    ).json()

    # B는 개발팀 공간 접근 불가 -> 팀 공간으로 이동 시도하면 403이어야 한다
    admin_client_spaces = as_user(admin_client, "a@test.local")
    team_space_id = admin_client_spaces["team"]["id"]

    as_user(admin_client, "b@test.local")
    res = admin_client.patch(
        f"/api/nodes/{node['id']}", json={"move": True, "space_id": team_space_id}
    )
    assert res.status_code == 403

    # org로는 이동 가능
    sp = spaces_of(admin_client)
    res = admin_client.patch(
        f"/api/nodes/{node['id']}", json={"move": True, "space_id": sp["org"]["id"]}
    )
    assert res.status_code == 200
    assert res.json()["space_id"] == sp["org"]["id"]


# ---------- 휴지통 ----------


def test_soft_delete_trash_restore(admin_client):
    sp = spaces_of(admin_client)
    pid = sp["personal"]["id"]
    node = upload(admin_client, f"/api/spaces/{pid}/files", "지울파일.txt").json()

    assert admin_client.delete(f"/api/nodes/{node['id']}").status_code == 200
    assert admin_client.get(f"/api/files/{node['id']}").status_code == 404
    assert [n["name"] for n in admin_client.get(f"/api/spaces/{pid}/children").json()] == []

    trash = admin_client.get(f"/api/spaces/{pid}/trash").json()
    assert [n["name"] for n in trash] == ["지울파일.txt"]

    restored = admin_client.post(f"/api/nodes/{node['id']}/restore").json()
    assert restored["name"] == "지울파일.txt"
    assert admin_client.get(f"/api/files/{node['id']}").status_code == 200


# ---------- tar ----------


def test_folder_tar_download(admin_client):
    sp = spaces_of(admin_client)
    pid = sp["personal"]["id"]
    folder = admin_client.post("/api/nodes", json={"space_id": pid, "name": "배포"}).json()
    sub = admin_client.post(
        "/api/nodes", json={"space_id": pid, "parent_id": folder["id"], "name": "설정"}
    ).json()
    upload(admin_client, f"/api/nodes/{folder['id']}/files", "모델.bin", b"AAA")
    upload(admin_client, f"/api/nodes/{sub['id']}/files", "config.yml", b"key: v")

    res = admin_client.get(f"/api/nodes/{folder['id']}/tar")
    assert res.status_code == 200
    assert res.headers["content-type"] == "application/gzip"

    with tarfile.open(fileobj=io.BytesIO(res.content), mode="r:gz") as tar:
        names = sorted(tar.getnames())
        assert names == ["배포", "배포/모델.bin", "배포/설정", "배포/설정/config.yml"]
        member = tar.extractfile("배포/설정/config.yml")
        assert member is not None and member.read() == b"key: v"


# ---------- 딥링크 경로 ----------


def test_node_path_for_deeplink(admin_client):
    sp = spaces_of(admin_client)
    pid = sp["personal"]["id"]
    a = admin_client.post("/api/nodes", json={"space_id": pid, "name": "A"}).json()
    b = admin_client.post(
        "/api/nodes", json={"space_id": pid, "parent_id": a["id"], "name": "B"}
    ).json()
    f = upload(admin_client, f"/api/nodes/{b['id']}/files", "deep.txt").json()

    res = admin_client.get(f"/api/nodes/{f['id']}/path").json()
    assert res["node"]["name"] == "deep.txt"
    assert [n["name"] for n in res["ancestors"]] == ["A", "B"]
    assert res["space_id"] == pid


# ---------- MD 편집 저장 (낙관적 잠금) ----------


def test_save_content_roundtrip_and_conflict(admin_client):
    sp = spaces_of(admin_client)
    node = upload(
        admin_client, f"/api/spaces/{sp['personal']['id']}/files", "문서.md", b"# v1"
    ).json()

    saved = admin_client.put(
        f"/api/files/{node['id']}/content",
        json={"content": "# v2 수정", "base_updated_at": node["updated_at"]},
    )
    assert saved.status_code == 200
    fresh = saved.json()
    assert fresh["updated_at"] != node["updated_at"]
    assert admin_client.get(f"/api/files/{node['id']}/raw").text == "# v2 수정"

    # 낡은 base로 저장하면 409
    stale = admin_client.put(
        f"/api/files/{node['id']}/content",
        json={"content": "# v3", "base_updated_at": node["updated_at"]},
    )
    assert stale.status_code == 409

    # 최신 base로는 성공
    ok = admin_client.put(
        f"/api/files/{node['id']}/content",
        json={"content": "# v3", "base_updated_at": fresh["updated_at"]},
    )
    assert ok.status_code == 200


def test_save_content_requires_space_permission(admin_client, db):
    setup_people(admin_client, db)
    a_spaces = as_user(admin_client, "a@test.local")
    node = upload(
        admin_client, f"/api/spaces/{a_spaces['personal']['id']}/files", "개인.md", b"x"
    ).json()

    as_user(admin_client, "b@test.local")
    res = admin_client.put(
        f"/api/files/{node['id']}/content", json={"content": "해킹", "base_updated_at": None}
    )
    assert res.status_code == 403


def test_node_out_includes_created_and_updated(admin_client):
    sp = spaces_of(admin_client)
    node = upload(admin_client, f"/api/spaces/{sp['personal']['id']}/files", "t.md").json()
    assert node["created_at"] and node["updated_at"]
    # 목록에서도 created_at이 내려온다
    row = admin_client.get(f"/api/spaces/{sp['personal']['id']}/children").json()[0]
    assert "created_at" in row and "updated_at" in row


# ---------- 공간 간 복사 ----------


def test_copy_file_to_org_keeps_original(admin_client):
    sp = spaces_of(admin_client)
    url = f"/api/spaces/{sp['personal']['id']}/files"
    src = upload(admin_client, url, "원본.txt", b"DATA").json()
    res = admin_client.post(f"/api/nodes/{src['id']}/copy", json={"space_id": sp["org"]["id"]})
    assert res.status_code == 201
    copy = res.json()
    assert copy["id"] != src["id"] and copy["space_id"] == sp["org"]["id"]
    # 원본은 개인 공간에 그대로
    p_children = admin_client.get(f"/api/spaces/{sp['personal']['id']}/children").json()
    o_children = admin_client.get(f"/api/spaces/{sp['org']['id']}/children").json()
    names_personal = [n["name"] for n in p_children]
    names_org = [n["name"] for n in o_children]
    assert "원본.txt" in names_personal and "원본.txt" in names_org
    # 복사본 내용 동일, 별도 blob
    assert admin_client.get(f"/api/files/{copy['id']}/raw").content == b"DATA"
    admin_client.delete(f"/api/nodes/{src['id']}")  # 원본 삭제해도
    assert admin_client.get(f"/api/files/{copy['id']}/raw").content == b"DATA"  # 복사본 살아 있음


def test_copy_folder_recursively(admin_client):
    sp = spaces_of(admin_client)
    pid = sp["personal"]["id"]
    folder = admin_client.post("/api/nodes", json={"space_id": pid, "name": "폴더"}).json()
    sub = admin_client.post(
        "/api/nodes", json={"space_id": pid, "parent_id": folder["id"], "name": "하위"}
    ).json()
    upload(admin_client, f"/api/nodes/{folder['id']}/files", "a.txt", b"A")
    upload(admin_client, f"/api/nodes/{sub['id']}/files", "b.txt", b"B")

    res = admin_client.post(f"/api/nodes/{folder['id']}/copy", json={"space_id": sp["org"]["id"]})
    assert res.status_code == 201
    new_folder = res.json()
    # 복사본 트리 확인
    top = admin_client.get(f"/api/nodes/{new_folder['id']}/children").json()
    assert sorted(n["name"] for n in top) == ["a.txt", "하위"]
    new_sub = next(n for n in top if n["name"] == "하위")
    subchildren = admin_client.get(f"/api/nodes/{new_sub['id']}/children").json()
    assert [n["name"] for n in subchildren] == ["b.txt"]


def test_copy_requires_both_spaces_accessible(admin_client, db):
    setup_people(admin_client, db)
    # B의 개인 파일을 A의 팀 공간(B 접근 불가)으로 복사 시도 → 403
    b_spaces = as_user(admin_client, "b@test.local")
    node = upload(admin_client, f"/api/spaces/{b_spaces['personal']['id']}/files", "x.txt").json()
    a_spaces = as_user(admin_client, "a@test.local")
    team_space = a_spaces["team"]["id"]
    as_user(admin_client, "b@test.local")
    r = admin_client.post(f"/api/nodes/{node['id']}/copy", json={"space_id": team_space})
    assert r.status_code == 403


def test_space_folders_flat_list(admin_client):
    sp = spaces_of(admin_client)
    pid = sp["personal"]["id"]
    a = admin_client.post("/api/nodes", json={"space_id": pid, "name": "A"}).json()
    admin_client.post("/api/nodes", json={"space_id": pid, "parent_id": a["id"], "name": "B"})
    admin_client.post("/api/nodes", json={"space_id": pid, "name": "C"})
    upload(admin_client, f"/api/spaces/{pid}/files", "file.txt")  # 파일은 제외돼야

    folders = admin_client.get(f"/api/spaces/{pid}/folders").json()
    names = {f["name"] for f in folders}
    assert names == {"A", "B", "C"}  # 파일 file.txt 없음
    b_row = next(f for f in folders if f["name"] == "B")
    assert b_row["parent_id"] == a["id"]  # 계층(parent_id) 포함
