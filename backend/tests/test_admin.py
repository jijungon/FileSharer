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
