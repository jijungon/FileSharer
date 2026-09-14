from tests.conftest import login


def make_member(admin_client, email="user@test.local", password="pw-123456"):
    res = admin_client.post(
        "/api/users", json={"email": email, "password": password, "name": "유저"}
    )
    assert res.status_code == 201
    return res.json()


def test_admin_endpoints_require_admin(client, db):
    from app.bootstrap import create_user

    create_user(db, email="plain@test.local", password="pw-123456")
    db.commit()
    login(client, "plain@test.local", "pw-123456")

    assert client.get("/api/users").status_code == 403
    assert client.post("/api/teams", json={"name": "x"}).status_code == 403


def test_invite_and_duplicate(admin_client):
    make_member(admin_client)
    dup = admin_client.post("/api/users", json={"email": "user@test.local"})
    assert dup.status_code == 409


def test_invited_user_can_login_and_has_personal_space(admin_client):
    make_member(admin_client, email="fresh@test.local")
    assert admin_client.post("/api/auth/logout").status_code == 200
    assert login(admin_client, "fresh@test.local", "pw-123456").status_code == 200
    types = [s["type"] for s in admin_client.get("/api/spaces").json()]
    assert types == ["personal", "org"]


def test_patch_role_and_disable(admin_client):
    user = make_member(admin_client, email="target@test.local")

    res = admin_client.patch(f"/api/users/{user['id']}", json={"role": "admin"})
    assert res.json()["role"] == "admin"

    res = admin_client.patch(f"/api/users/{user['id']}", json={"disabled": True})
    assert res.json()["disabled"] is True

    assert admin_client.post("/api/auth/logout").status_code == 200
    assert login(admin_client, "target@test.local", "pw-123456").status_code == 401


def test_admin_cannot_disable_or_demote_self(admin_client):
    me = admin_client.get("/api/me").json()
    assert admin_client.patch(f"/api/users/{me['id']}", json={"disabled": True}).status_code == 400
    assert admin_client.patch(f"/api/users/{me['id']}", json={"role": "member"}).status_code == 400


def test_team_lifecycle_grants_space_access(admin_client):
    user = make_member(admin_client, email="dev@test.local")

    team = admin_client.post("/api/teams", json={"name": "개발팀"}).json()
    assert admin_client.post("/api/teams", json={"name": "개발팀"}).status_code == 409

    res = admin_client.post(f"/api/teams/{team['id']}/members", json={"user_id": user["id"]})
    assert res.status_code == 201
    assert (
        admin_client.post(
            f"/api/teams/{team['id']}/members", json={"user_id": user["id"]}
        ).status_code
        == 409
    )

    # 팀원이 되면 팀 공간이 보인다
    admin_client.post("/api/auth/logout")
    login(admin_client, "dev@test.local", "pw-123456")
    types = [s["type"] for s in admin_client.get("/api/spaces").json()]
    assert types == ["personal", "team", "org"]

    # 팀원 열람은 팀원 가능
    members = admin_client.get(f"/api/teams/{team['id']}/members")
    assert members.status_code == 200
    assert members.json()[0]["email"] == "dev@test.local"


def test_remove_member_revokes_space(admin_client):
    user = make_member(admin_client, email="temp@test.local")
    team = admin_client.post("/api/teams", json={"name": "임시팀"}).json()
    admin_client.post(f"/api/teams/{team['id']}/members", json={"user_id": user["id"]})

    res = admin_client.delete(f"/api/teams/{team['id']}/members/{user['id']}")
    assert res.status_code == 200

    admin_client.post("/api/auth/logout")
    login(admin_client, "temp@test.local", "pw-123456")
    types = [s["type"] for s in admin_client.get("/api/spaces").json()]
    assert types == ["personal", "org"]

    # 비팀원의 팀원 열람은 403
    assert admin_client.get(f"/api/teams/{team['id']}/members").status_code == 403


def _team_space_id(client, team_id):
    # 팀원으로서 팀 공간 id 조회
    return next(s["id"] for s in client.get("/api/spaces").json() if s["type"] == "team")


def test_delete_empty_team(admin_client):
    me = admin_client.get("/api/me").json()
    team = admin_client.post("/api/teams", json={"name": "지울팀"}).json()
    admin_client.post(f"/api/teams/{team['id']}/members", json={"user_id": me["id"]})
    # 팀 공간이 보인다
    assert any(s["type"] == "team" for s in admin_client.get("/api/spaces").json())

    res = admin_client.delete(f"/api/teams/{team['id']}")
    assert res.status_code == 200
    # 팀 목록·공간에서 사라진다
    assert admin_client.get("/api/teams").json() == []
    assert not any(s["type"] == "team" for s in admin_client.get("/api/spaces").json())


def test_delete_team_requires_admin(admin_client, db):
    from app.bootstrap import create_user

    team = admin_client.post("/api/teams", json={"name": "보호팀"}).json()
    create_user(db, email="member2@test.local", password="pw-123456")
    db.commit()
    admin_client.post("/api/auth/logout")
    login(admin_client, "member2@test.local", "pw-123456")
    assert admin_client.delete(f"/api/teams/{team['id']}").status_code == 403


def test_delete_team_blocked_when_files_present(admin_client):
    import io

    me = admin_client.get("/api/me").json()
    team = admin_client.post("/api/teams", json={"name": "파일팀"}).json()
    admin_client.post(f"/api/teams/{team['id']}/members", json={"user_id": me["id"]})
    tsp = _team_space_id(admin_client, team["id"])
    admin_client.post(
        f"/api/spaces/{tsp}/files", files={"file": ("t.txt", io.BytesIO(b"x"), "text/plain")}
    )
    # 활성 파일이 있으면 409
    assert admin_client.delete(f"/api/teams/{team['id']}").status_code == 409
    # 비우면(휴지통) 삭제 가능
    nid = admin_client.get(f"/api/spaces/{tsp}/children").json()[0]["id"]
    admin_client.delete(f"/api/nodes/{nid}")
    assert admin_client.delete(f"/api/teams/{team['id']}").status_code == 200


def test_delete_nonexistent_team(admin_client):
    assert admin_client.delete("/api/teams/nope").status_code == 404


def test_force_delete_team_with_files(admin_client):
    import io

    me = admin_client.get("/api/me").json()
    team = admin_client.post("/api/teams", json={"name": "강제팀"}).json()
    admin_client.post(f"/api/teams/{team['id']}/members", json={"user_id": me["id"]})
    tsp = _team_space_id(admin_client, team["id"])
    # 폴더 + 하위 파일 + 공유까지 만들어 둔다
    folder = admin_client.post("/api/nodes", json={"space_id": tsp, "name": "f"}).json()
    admin_client.post(
        f"/api/nodes/{folder['id']}/files",
        files={"file": ("t.txt", io.BytesIO(b"x"), "text/plain")},
    )
    admin_client.post(
        f"/api/spaces/{tsp}/files", files={"file": ("r.txt", io.BytesIO(b"y"), "text/plain")}
    )
    nid = admin_client.get(f"/api/spaces/{tsp}/children").json()[0]["id"]
    admin_client.post(f"/api/nodes/{nid}/shares", json={})

    # 일반 삭제는 409
    assert admin_client.delete(f"/api/teams/{team['id']}").status_code == 409
    # force=true면 파일까지 지우고 팀 삭제
    assert admin_client.delete(f"/api/teams/{team['id']}?force=true").status_code == 200
    assert admin_client.get("/api/teams").json() == []
    assert not any(s["type"] == "team" for s in admin_client.get("/api/spaces").json())


def test_force_delete_requires_admin(admin_client, db):
    from app.bootstrap import create_user

    team = admin_client.post("/api/teams", json={"name": "권한팀"}).json()
    create_user(db, email="np3@test.local", password="pw-123456")
    db.commit()
    admin_client.post("/api/auth/logout")
    login(admin_client, "np3@test.local", "pw-123456")
    assert admin_client.delete(f"/api/teams/{team['id']}?force=true").status_code == 403
