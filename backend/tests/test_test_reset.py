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
