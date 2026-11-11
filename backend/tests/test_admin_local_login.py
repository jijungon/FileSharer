"""비밀번호 로그인이 꺼진 서버에선 비밀번호 계정을 새로 만들 수도 없다."""

from fastapi.testclient import TestClient

from app.bootstrap import create_user
from app.models import User


def test_invite_with_password_rejected_when_local_login_off(app_factory):
    app = app_factory(ENABLE_LOCAL_LOGIN="0")
    with TestClient(app) as c:
        with c.app.state.sessionmaker() as s:
            admin = create_user(s, email="g-admin@test.local", role="admin")
            s.commit()
            admin_id = admin.id
        # 구글 로그인을 대신해 세션을 직접 심는다(이 서버엔 비밀번호 로그인이 없다)
        from app.deps import current_user, require_admin

        def _admin():
            with c.app.state.sessionmaker() as s:
                return s.get(User, admin_id)

        app.dependency_overrides[require_admin] = _admin
        app.dependency_overrides[current_user] = _admin

        res = c.post("/api/users", json={"email": "x@test.local", "password": "some-pass-123"})
        assert res.status_code == 422
        # 비밀번호 없이 미리 만들어 두는 건 된다 — 그 사람은 구글로 들어온다
        res = c.post("/api/users", json={"email": "x@test.local"})
        assert res.status_code == 201
        assert res.json()["local_login"] is False
