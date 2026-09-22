"""서버(헤드리스) 업로드용 API 토큰 — 발급→업로드→회수 전 과정과 범위·인증 경계."""

import io
import tarfile
import zipfile
from datetime import UTC, datetime, timedelta

from fastapi.testclient import TestClient

from app.models import ApiToken, utcnow


def spaces_of(client):
    return {s["type"]: s for s in client.get("/api/spaces").json()}


def make_token(admin_client, **body):
    res = admin_client.post("/api/tokens", json=body)
    assert res.status_code == 201, res.text
    return res.json()


def bare_client(admin_client) -> TestClient:
    """세션 쿠키가 없는 새 클라이언트 — 순수 토큰(Bearer) 인증을 증명하기 위함."""
    return TestClient(admin_client.app)


def upload_with_token(client, url, token, name="a.log", content=b"log-bytes"):
    return client.post(
        url,
        headers={"Authorization": f"Bearer {token}"},
        files={"file": (name, io.BytesIO(content), "text/plain")},
    )


def test_create_returns_plaintext_once_and_list_hides_it(admin_client):
    created = make_token(admin_client, label="ci-runner")
    assert created["token"].startswith("fsk_")
    assert "warning" in created
    assert created["scope_label"] == "내 공간(기본)"

    rows = admin_client.get("/api/tokens").json()
    row = next(r for r in rows if r["id"] == created["id"])
    assert "token" not in row  # 목록엔 원문이 절대 없다
    assert "token_hash" not in row
    assert row["label"] == "ci-runner"
    assert row["last_used_at"] is None


def test_token_uploads_to_scoped_space_without_session(admin_client):
    oid = spaces_of(admin_client)["org"]["id"]
    tok = make_token(admin_client, space_id=oid, label="org-uploader")
    bare = bare_client(admin_client)  # 세션 쿠키 없음
    res = upload_with_token(bare, f"/api/spaces/{oid}/files", tok["token"], name="pushed.log")
    assert res.status_code == 201, res.text
    assert res.json()["name"] == "pushed.log"
    # 파일이 실제로 그 공간에 생겼는지(업로더=토큰 소유자)
    tree = admin_client.get(f"/api/spaces/{oid}/tree").json()
    assert any(n["name"] == "pushed.log" for n in tree)
    # last_used_at 이 갱신됨
    row = next(r for r in admin_client.get("/api/tokens").json() if r["id"] == tok["id"])
    assert row["last_used_at"] is not None


def test_space_scope_denies_other_space(admin_client):
    sp = spaces_of(admin_client)
    pid, oid = sp["personal"]["id"], sp["org"]["id"]
    tok = make_token(admin_client, space_id=oid)
    bare = bare_client(admin_client)
    assert upload_with_token(bare, f"/api/spaces/{oid}/files", tok["token"]).status_code == 201
    denied = upload_with_token(bare, f"/api/spaces/{pid}/files", tok["token"])
    assert denied.status_code == 403


def test_null_scope_defaults_to_personal_only(admin_client):
    sp = spaces_of(admin_client)
    pid, oid = sp["personal"]["id"], sp["org"]["id"]
    tok = make_token(admin_client)  # 범위 미지정 → 개인 공간만
    bare = bare_client(admin_client)
    assert upload_with_token(bare, f"/api/spaces/{pid}/files", tok["token"]).status_code == 201
    assert upload_with_token(bare, f"/api/spaces/{oid}/files", tok["token"]).status_code == 403


def test_folder_scope_allows_folder_denies_root(admin_client):
    pid = spaces_of(admin_client)["personal"]["id"]
    folder = admin_client.post("/api/nodes", json={"space_id": pid, "name": "수집함"}).json()
    tok = make_token(admin_client, node_id=folder["id"], label="collector")
    assert tok["scope_label"] == "폴더: 수집함"
    bare = bare_client(admin_client)
    into = upload_with_token(bare, f"/api/nodes/{folder['id']}/files", tok["token"])
    assert into.status_code == 201
    root = upload_with_token(bare, f"/api/spaces/{pid}/files", tok["token"])
    assert root.status_code == 403


def test_folder_scope_allows_descendant_via_rel_path(admin_client):
    """폴더 범위 토큰은 rel_path로 만든 하위 폴더에도 업로드할 수 있어야 한다."""
    pid = spaces_of(admin_client)["personal"]["id"]
    folder = admin_client.post("/api/nodes", json={"space_id": pid, "name": "logs"}).json()
    tok = make_token(admin_client, node_id=folder["id"])
    bare = bare_client(admin_client)
    res = bare.post(
        f"/api/nodes/{folder['id']}/files",
        headers={"Authorization": f"Bearer {tok['token']}"},
        files={"file": ("day.log", io.BytesIO(b"x"), "text/plain")},
        data={"rel_path": "2026/09/day.log"},
    )
    assert res.status_code == 201, res.text


def test_revoked_token_rejected(admin_client):
    pid = spaces_of(admin_client)["personal"]["id"]
    tok = make_token(admin_client)
    bare = bare_client(admin_client)
    assert upload_with_token(bare, f"/api/spaces/{pid}/files", tok["token"]).status_code == 201
    assert admin_client.delete(f"/api/tokens/{tok['id']}").status_code == 200
    after = upload_with_token(bare, f"/api/spaces/{pid}/files", tok["token"])
    assert after.status_code == 401
    # 회수된 토큰은 목록에서 사라진다
    assert all(r["id"] != tok["id"] for r in admin_client.get("/api/tokens").json())


def test_expired_token_rejected(admin_client, db):
    pid = spaces_of(admin_client)["personal"]["id"]
    tok = make_token(admin_client, expires_in_days=1)
    row = db.get(ApiToken, tok["id"])
    row.expires_at = utcnow() - timedelta(days=1)  # 강제로 과거로
    db.commit()
    bare = bare_client(admin_client)
    res = upload_with_token(bare, f"/api/spaces/{pid}/files", tok["token"])
    assert res.status_code == 401


def test_invalid_tokens_rejected(admin_client):
    pid = spaces_of(admin_client)["personal"]["id"]
    bare = bare_client(admin_client)
    for bad in ["garbage", "fsk_deadbeefdeadbeefdeadbeefdeadbeef.nope", "fsk_no-dot-secret"]:
        res = upload_with_token(bare, f"/api/spaces/{pid}/files", bad)
        assert res.status_code == 401, bad


def test_no_auth_still_401(admin_client):
    pid = spaces_of(admin_client)["personal"]["id"]
    bare = bare_client(admin_client)
    res = bare.post(
        f"/api/spaces/{pid}/files",
        files={"file": ("x.txt", io.BytesIO(b"x"), "text/plain")},
    )
    assert res.status_code == 401


def test_session_upload_still_works(admin_client):
    """회귀: 기존 세션 쿠키 업로드가 그대로 동작해야 한다."""
    pid = spaces_of(admin_client)["personal"]["id"]
    res = admin_client.post(
        f"/api/spaces/{pid}/files",
        files={"file": ("session.txt", io.BytesIO(b"x"), "text/plain")},
    )
    assert res.status_code == 201


def test_create_token_rejects_file_scope(admin_client):
    pid = spaces_of(admin_client)["personal"]["id"]
    f = admin_client.post(
        f"/api/spaces/{pid}/files",
        files={"file": ("scope.txt", io.BytesIO(b"x"), "text/plain")},
    ).json()
    res = admin_client.post("/api/tokens", json={"node_id": f["id"]})
    assert res.status_code == 422


def test_cannot_revoke_others_token(admin_client, db):
    """다른 사용자의 토큰은 회수할 수 없다(404)."""
    from app.bootstrap import create_user

    other = create_user(db, email="dev@corp.example", password="pw-123456")
    db.commit()
    tok = ApiToken(user_id=other.id, label="theirs", token_hash="x")
    db.add(tok)
    db.commit()
    res = admin_client.delete(f"/api/tokens/{tok.id}")
    assert res.status_code == 404


def test_token_upload_is_audited_with_label(admin_client):
    pid = spaces_of(admin_client)["personal"]["id"]
    tok = make_token(admin_client, label="nightly-backup")
    bare = bare_client(admin_client)
    res = upload_with_token(bare, f"/api/spaces/{pid}/files", tok["token"], name="dump.sql")
    assert res.status_code == 201
    rows = admin_client.get("/api/system/audit?action=upload").json()
    assert any("토큰:nightly-backup" in r["detail"] for r in rows)


def test_short_lived_token_allows_multiple_uploads(admin_client):
    """짧은 만료(분) '임시 토큰' 하나로 그 창 안에서 여러 파일을 올릴 수 있어야 한다.

    서버 업로드 UX의 핵심: '임시 토큰 발급' 버튼이 10분짜리 토큰을 만들고,
    사용자는 그 하나로 파일 여러 개를 밀어넣은 뒤 그냥 만료되게 둔다(단일사용 아님).
    """
    pid = spaces_of(admin_client)["personal"]["id"]
    tok = make_token(admin_client, expires_in_minutes=10, label="temp-upload")
    assert tok["expires_at"] is not None  # 무기한이 아니라 만료가 설정됨
    exp = datetime.fromisoformat(tok["expires_at"])
    assert exp - datetime.now(UTC) < timedelta(minutes=11)  # 일이 아닌 '분' 단위
    bare = bare_client(admin_client)
    for i in range(3):
        res = upload_with_token(bare, f"/api/spaces/{pid}/files", tok["token"], name=f"f{i}.log")
        assert res.status_code == 201, res.text  # 같은 토큰으로 3번 연속 성공
    names = {n["name"] for n in admin_client.get(f"/api/spaces/{pid}/tree").json()}
    assert {"f0.log", "f1.log", "f2.log"} <= names


def _mint_status(admin_client, minutes):
    return admin_client.post("/api/tokens", json={"expires_in_minutes": minutes}).status_code


def test_expires_in_minutes_out_of_range_rejected(admin_client):
    assert _mint_status(admin_client, 0) == 422
    assert _mint_status(admin_client, 24 * 60 + 1) == 422
    assert _mint_status(admin_client, 1) == 201  # 경계: 최소 1분
    assert _mint_status(admin_client, 24 * 60) == 201  # 경계: 최대 하루


def test_short_lived_token_rejected_after_expiry(admin_client, db):
    """분 단위 만료 토큰도 시간이 지나면 401(자동 소멸)."""
    pid = spaces_of(admin_client)["personal"]["id"]
    tok = make_token(admin_client, expires_in_minutes=10)
    row = db.get(ApiToken, tok["id"])
    row.expires_at = utcnow() - timedelta(minutes=1)  # 강제로 과거로
    db.commit()
    bare = bare_client(admin_client)
    res = upload_with_token(bare, f"/api/spaces/{pid}/files", tok["token"])
    assert res.status_code == 401


def _multi(names):
    return [(("file"), (n, io.BytesIO(f"body-{n}".encode()), "text/plain")) for n in names]


def test_multiple_files_in_one_request_returns_list(admin_client):
    """한 요청에 file 필드 여러 개 → 모두 업로드되고 '목록'으로 응답(단일 토큰, 한 번에)."""
    pid = spaces_of(admin_client)["personal"]["id"]
    tok = make_token(admin_client, expires_in_minutes=10)
    bare = bare_client(admin_client)
    res = bare.post(
        f"/api/spaces/{pid}/files",
        headers={"Authorization": f"Bearer {tok['token']}"},
        files=_multi(["m1.log", "m2.log", "m3.log"]),
    )
    assert res.status_code == 201, res.text
    body = res.json()
    assert isinstance(body, list)
    assert {n["name"] for n in body} == {"m1.log", "m2.log", "m3.log"}


def test_single_file_still_returns_object(admin_client):
    """하위호환: 파일 하나면 예전처럼 '단일 객체'를 반환(목록 아님) — 프론트/스크립트 무영향."""
    pid = spaces_of(admin_client)["personal"]["id"]
    tok = make_token(admin_client)
    bare = bare_client(admin_client)
    res = upload_with_token(bare, f"/api/spaces/{pid}/files", tok["token"], name="solo.log")
    assert res.status_code == 201
    body = res.json()
    assert isinstance(body, dict)
    assert body["name"] == "solo.log"


def test_rel_path_rejected_with_multiple_files(admin_client):
    """rel_path(중간 폴더 생성)는 파일 하나일 때만 — 여러 개면 422."""
    pid = spaces_of(admin_client)["personal"]["id"]
    tok = make_token(admin_client)
    bare = bare_client(admin_client)
    res = bare.post(
        f"/api/spaces/{pid}/files",
        headers={"Authorization": f"Bearer {tok['token']}"},
        files=_multi(["a.log", "b.log"]),
        data={"rel_path": "2026/09/"},
    )
    assert res.status_code == 422


def test_token_routed_upload_folder_scope(admin_client):
    """/api/upload — URL에 id 없이 '토큰 범위'가 목적지. 폴더범위 토큰은 그 폴더로 들어간다."""
    pid = spaces_of(admin_client)["personal"]["id"]
    folder = admin_client.post("/api/nodes", json={"space_id": pid, "name": "inbox"}).json()
    tok = make_token(admin_client, node_id=folder["id"], expires_in_minutes=10)
    bare = bare_client(admin_client)
    res = bare.post(
        "/api/upload",
        headers={"Authorization": f"Bearer {tok['token']}"},
        files=_multi(["r1.log", "r2.log"]),
    )
    assert res.status_code == 201, res.text
    assert len(res.json()) == 2
    kids = {n["name"] for n in admin_client.get(f"/api/nodes/{folder['id']}/children").json()}
    assert {"r1.log", "r2.log"} <= kids


def test_token_routed_upload_space_and_null_scope(admin_client):
    """/api/upload — 공간범위 토큰은 그 공간 루트, 범위없음 토큰은 개인 공간 루트로."""
    sp = spaces_of(admin_client)
    pid, oid = sp["personal"]["id"], sp["org"]["id"]
    bare = bare_client(admin_client)

    otok = make_token(admin_client, space_id=oid)
    r1 = bare.post(
        "/api/upload",
        headers={"Authorization": f"Bearer {otok['token']}"},
        files={"file": ("o.log", io.BytesIO(b"x"), "text/plain")},
    )
    assert r1.status_code == 201
    assert r1.json()["name"] == "o.log"  # 단일=객체
    assert any(n["name"] == "o.log" for n in admin_client.get(f"/api/spaces/{oid}/tree").json())

    ptok = make_token(admin_client)  # 범위없음 → 개인 공간
    r2 = bare.post(
        "/api/upload",
        headers={"Authorization": f"Bearer {ptok['token']}"},
        files={"file": ("p.log", io.BytesIO(b"x"), "text/plain")},
    )
    assert r2.status_code == 201
    assert any(n["name"] == "p.log" for n in admin_client.get(f"/api/spaces/{pid}/tree").json())


def test_token_routed_upload_requires_token_not_session(admin_client):
    """/api/upload 는 목적지를 정할 토큰이 필요 — 세션 쿠키만으론 401."""
    res = admin_client.post(  # admin_client=세션 쿠키 있음, Bearer 없음
        "/api/upload",
        files={"file": ("s.log", io.BytesIO(b"x"), "text/plain")},
    )
    assert res.status_code == 401


def _targz(files: dict[str, bytes]) -> bytes:
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tf:
        for name, data in files.items():
            info = tarfile.TarInfo(name)
            info.size = len(data)
            tf.addfile(info, io.BytesIO(data))
    return buf.getvalue()


def _zip(files: dict[str, bytes]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        for name, data in files.items():
            zf.writestr(name, data)
    return buf.getvalue()


def test_upload_extract_targz_preserves_structure(admin_client):
    """?extract=tar — tar.gz를 올리면 서버가 풀어 하위 폴더 구조를 그대로 만든다."""
    pid = spaces_of(admin_client)["personal"]["id"]
    tok = make_token(admin_client)
    bare = bare_client(admin_client)
    blob = _targz({"mydir/a.log": b"a", "mydir/sub/b.log": b"bb"})
    res = bare.post(
        "/api/upload?extract=tar",
        headers={"Authorization": f"Bearer {tok['token']}"},
        files={"file": ("mydir.tgz", io.BytesIO(blob), "application/gzip")},
    )
    assert res.status_code == 201, res.text
    assert len(res.json()) == 2  # 파일 2개 모두 노드로
    names = {n["name"] for n in admin_client.get(f"/api/spaces/{pid}/tree").json()}
    assert {"mydir", "sub", "a.log", "b.log"} <= names  # 폴더 구조 재현


def test_upload_extract_zip(admin_client):
    """?extract=zip 도 동일하게 풀린다."""
    pid = spaces_of(admin_client)["personal"]["id"]
    tok = make_token(admin_client)
    bare = bare_client(admin_client)
    blob = _zip({"z/one.txt": b"1", "z/two.txt": b"2"})
    res = bare.post(
        "/api/upload?extract=zip",
        headers={"Authorization": f"Bearer {tok['token']}"},
        files={"file": ("z.zip", io.BytesIO(blob), "application/zip")},
    )
    assert res.status_code == 201, res.text
    assert len(res.json()) == 2
    names = {n["name"] for n in admin_client.get(f"/api/spaces/{pid}/tree").json()}
    assert {"z", "one.txt", "two.txt"} <= names


def test_upload_extract_skips_macos_junk(admin_client):
    """macOS 아카이브 메타데이터(._* , __MACOSX/)는 풀 때 건너뛴다 — 진짜 파일만 남는다."""
    tok = make_token(admin_client)
    bare = bare_client(admin_client)
    blob = _targz({"d/real.log": b"x", "d/._real.log": b"junk", "__MACOSX/d/._real.log": b"j"})
    res = bare.post(
        "/api/upload?extract=tar",
        headers={"Authorization": f"Bearer {tok['token']}"},
        files={"file": ("d.tgz", io.BytesIO(blob), "application/gzip")},
    )
    assert res.status_code == 201, res.text
    assert [n["name"] for n in res.json()] == ["real.log"]


def test_upload_extract_rejects_path_traversal(admin_client):
    """압축 안에 '../' 경로 탈출이 있으면 422로 거부(서버 밖으로 못 쓴다)."""
    tok = make_token(admin_client)
    bare = bare_client(admin_client)
    blob = _targz({"../evil.log": b"x"})
    res = bare.post(
        "/api/upload?extract=tar",
        headers={"Authorization": f"Bearer {tok['token']}"},
        files={"file": ("evil.tgz", io.BytesIO(blob), "application/gzip")},
    )
    assert res.status_code == 422


def test_reset_route_absent_without_flag(admin_client):
    """프로덕션 안전장치: ENABLE_TEST_RESET 없으면 reset POST 핸들러가 없다(404/405 — 실행 안 됨)."""
    assert admin_client.post("/api/test/reset").status_code in (404, 405)
