"""/api/test/reset 이 DB 행뿐 아니라 블롭까지 지우는지 — 고아 오브젝트 누적 방지 회귀 테스트.

배경: 예전 리셋은 행만 지워서 블롭이 스토리지에 남았다. 원격 스토리지(R2)를 쓰는 로컬
환경에서 e2e를 반복하면 참조 없는 고아가 수백 개씩 쌓였다(실제로 992개 누적 후 정리).
"""

import io

from fastapi.testclient import TestClient

ADMIN_EMAIL = "admin@test.local"
ADMIN_PASSWORD = "admin-pass-123"


def spaces_of(client):
    return {s["type"]: s for s in client.get("/api/spaces").json()}


def test_reset_deletes_blobs_not_just_rows(app_factory, tmp_path):
    app = app_factory(
        ADMIN_EMAIL=ADMIN_EMAIL, ADMIN_PASSWORD=ADMIN_PASSWORD, ENABLE_TEST_RESET="1"
    )
    with TestClient(app) as c:
        assert (
            c.post(
                "/api/auth/login", json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD}
            ).status_code
            == 200
        )
        pid = spaces_of(c)["personal"]["id"]
        c.post(
            f"/api/spaces/{pid}/files",
            files={"file": ("리셋대상.txt", io.BytesIO(b"bye"), "text/plain")},
        ).raise_for_status()

        blobs = tmp_path / "data" / "blobs"
        assert len(list(blobs.iterdir())) == 1, "업로드된 블롭이 있어야 한다"
        assert len(c.get(f"/api/spaces/{pid}/children").json()) == 1

        res = c.post("/api/test/reset")
        assert res.status_code == 200
        assert res.json()["blobs_deleted"] == 1

        # 행도 비고, 블롭도 남지 않는다
        assert c.get(f"/api/spaces/{pid}/children").json() == []
        assert list(blobs.iterdir()) == [], "리셋 후 블롭이 남아 있으면 고아가 쌓인다"


def test_reset_route_absent_without_flag(app_factory):
    """플래그가 없으면 리셋 POST 라우트 자체가 없어야 한다(프로덕션 보호).

    404가 아니라 405가 나오는 건 SPA 폴백(`GET /{path:path}`)이 같은 경로를 잡기 때문이다.
    POST 핸들러가 없다는 사실은 동일하므로 '리셋이 불가능하다'는 보호는 그대로 성립한다.
    """
    app = app_factory(ADMIN_EMAIL=ADMIN_EMAIL, ADMIN_PASSWORD=ADMIN_PASSWORD)
    with TestClient(app) as c:
        res = c.post("/api/test/reset")
        assert res.status_code in (404, 405), f"리셋이 노출되면 안 된다: {res.status_code}"
        assert res.status_code != 200


def test_reset_scoped_to_one_user_leaves_others_alone(app_factory):
    """`email` 을 주면 그 사람 개인 공간만 비운다 — 병렬 실행의 전제다.

    예전엔 무조건 전부 지웠다. 그러면 워커를 여러 개 띄울 수 없다 — 한 워커의 리셋이
    다른 워커가 방금 만든 파일을 지운다. 이 테스트가 그 경계를 고정한다.
    """
    app = app_factory(
        ADMIN_EMAIL=ADMIN_EMAIL, ADMIN_PASSWORD=ADMIN_PASSWORD, ENABLE_TEST_RESET="1"
    )
    with TestClient(app) as c:
        c.post("/api/auth/login", json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD})
        for email in ("w0@test.local", "w1@test.local"):
            c.post("/api/users", json={"email": email, "password": "pw-123456"})

        def upload_as(email: str, name: str) -> str:
            c.post("/api/auth/logout")
            c.post("/api/auth/login", json={"email": email, "password": "pw-123456"})
            pid = spaces_of(c)["personal"]["id"]
            return c.post(
                f"/api/spaces/{pid}/files",
                files={"file": (name, io.BytesIO(b"x"), "text/plain")},
            ).json()["id"]

        a = upload_as("w0@test.local", "w0것.txt")
        b = upload_as("w1@test.local", "w1것.txt")

        res = c.post("/api/test/reset", params={"email": "w0@test.local"})
        assert res.status_code == 200
        assert res.json()["nodes_deleted"] == 1  # w0 것 하나만

        # w0 것은 사라지고, w1 것은 **그대로 있어야 한다**
        c.post("/api/auth/logout")
        c.post("/api/auth/login", json={"email": "w0@test.local", "password": "pw-123456"})
        assert c.get(f"/api/files/{a}").status_code == 404
        c.post("/api/auth/logout")
        c.post("/api/auth/login", json={"email": "w1@test.local", "password": "pw-123456"})
        assert c.get(f"/api/files/{b}").status_code == 200


def test_reset_without_email_still_wipes_everything(app_factory):
    """범위를 안 주면 예전처럼 전부 — 실행 시작에 한 번 쓰는 용도."""
    app = app_factory(
        ADMIN_EMAIL=ADMIN_EMAIL, ADMIN_PASSWORD=ADMIN_PASSWORD, ENABLE_TEST_RESET="1"
    )
    with TestClient(app) as c:
        c.post("/api/auth/login", json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD})
        c.post("/api/users", json={"email": "w0@test.local", "password": "pw-123456"})
        c.post("/api/auth/logout")
        c.post("/api/auth/login", json={"email": "w0@test.local", "password": "pw-123456"})
        pid = spaces_of(c)["personal"]["id"]
        node = c.post(
            f"/api/spaces/{pid}/files",
            files={"file": ("남의것.txt", io.BytesIO(b"x"), "text/plain")},
        ).json()["id"]

        assert c.post("/api/test/reset").status_code == 200
        assert c.get(f"/api/files/{node}").status_code == 404


def test_reset_rejects_an_unknown_user(app_factory):
    """오타난 이메일을 조용히 '전부 삭제'로 처리하면 재앙이다."""
    app = app_factory(
        ADMIN_EMAIL=ADMIN_EMAIL, ADMIN_PASSWORD=ADMIN_PASSWORD, ENABLE_TEST_RESET="1"
    )
    with TestClient(app) as c:
        assert c.post("/api/test/reset", params={"email": "없는사람@test.local"}).status_code == 404
