from app.bootstrap import create_user
from app.models import Space, Team, TeamMember
from tests.conftest import login


def test_spaces_requires_login(client):
    assert client.get("/api/spaces").status_code == 401


def test_admin_sees_personal_and_org(admin_client):
    spaces = admin_client.get("/api/spaces").json()
    types = [s["type"] for s in spaces]
    assert types == ["personal", "org"]
    assert spaces[0]["name"] == "내 공간"
    assert spaces[-1]["name"] == "전체 공간"


def test_team_member_sees_team_space(client, db):
    user = create_user(db, email="member@test.local", password="pw-123456")
    team = Team(name="플랫폼팀")
    db.add(team)
    db.flush()
    db.add(TeamMember(team_id=team.id, user_id=user.id))
    db.add(Space(type="team", team_id=team.id))
    db.commit()

    assert login(client, "member@test.local", "pw-123456").status_code == 200
    spaces = client.get("/api/spaces").json()
    assert [s["type"] for s in spaces] == ["personal", "team", "org"]
    assert spaces[1]["name"] == "플랫폼팀"


def test_non_member_does_not_see_team_space(client, db):
    create_user(db, email="solo@test.local", password="pw-123456")
    team = Team(name="남의팀")
    db.add(team)
    db.flush()
    db.add(Space(type="team", team_id=team.id))
    db.commit()

    login(client, "solo@test.local", "pw-123456")
    spaces = client.get("/api/spaces").json()
    assert [s["type"] for s in spaces] == ["personal", "org"]
