"""CLI 로그인 — 디바이스 플로우(RFC 8628) 전 과정과 그 경계.

이 흐름은 **인증 없이 열린 엔드포인트**로 시작한다(디바이스 플로우는 원래 그렇다).
그래서 '되는가' 보다 '넘지 말아야 할 선을 넘지 않는가' 를 더 많이 본다.
"""

import io
import re
from datetime import timedelta

from sqlalchemy import select

from app.models import DeviceAuth, utcnow
from app.services import device_auth as flow


def bare(client):
    """세션 쿠키가 없는 새 클라이언트 — 터미널 쪽(미인증)을 흉내 낸다."""
    from fastapi.testclient import TestClient

    return TestClient(client.app)


def spaces_of(client):
    return {s["type"]: s for s in client.get("/api/spaces").json()}


def start(cli, name="joji-macbook"):
    res = cli.post("/api/device/code", json={"client_name": name})
    assert res.status_code == 201, res.text
    return res.json()


def poll(cli, device_code):
    return cli.post("/api/device/token", json={"device_code": device_code})


# ── 행복 경로 ────────────────────────────────────────────────────────────


def test_full_flow_terminal_never_sees_a_password(admin_client, monkeypatch):
    """터미널은 비밀번호를 한 번도 받지 않는다. 코드 한 쌍과 폴링만으로 토큰을 얻는다."""
    monkeypatch.setattr(flow, "POLL_INTERVAL_SEC", 0)  # 간격은 아래에서 따로 본다
    cli = bare(admin_client)

    started = start(cli)
    # 사람이 옮겨 적는 코드는 XXXX-XXXX, 헷갈리는 글자(0 O 1 I L)와 모음이 없다
    assert re.fullmatch(r"[BCDFGHJKMNPQRSTVWXZ23456789]{4}-[BCDFGHJKMNPQRSTVWXZ23456789]{4}",
                        started["user_code"])
    assert started["device_code"].startswith("fsd_")
    assert started["verification_uri"].endswith("/device")
    assert started["expires_in"] == flow.CODE_TTL_MIN * 60

    # 아직 아무도 승인 안 했다
    pending = poll(cli, started["device_code"])
    assert pending.status_code == 400
    assert pending.json()["detail"]["error"] == "authorization_pending"

    # 브라우저 쪽(로그인된 세션)이 무엇을 승인하는지 본다
    info = admin_client.get("/api/device/pending", params={"code": started["user_code"]})
    assert info.status_code == 200, info.text
    assert info.json()["client_name"] == "joji-macbook"

    assert admin_client.post(
        "/api/device/approve", json={"code": started["user_code"]}
    ).status_code == 200

    # 터미널이 토큰을 받아간다
    got = poll(cli, started["device_code"])
    assert got.status_code == 200, got.text
    token = got.json()["token"]
    assert token.startswith("fsk_")

    # 그 토큰으로 실제로 둘러볼 수 있어야 의미가 있다(#185 가 연 길)
    listed = cli.get("/api/spaces", headers={"Authorization": f"Bearer {token}"})
    assert listed.status_code == 200
    assert listed.json()  # 개인 공간 하나


def test_user_code_accepts_hyphenless_input(admin_client):
    """사람은 하이픈을 빼고 치거나 소문자로 친다. 그걸로 막으면 안 된다."""
    cli = bare(admin_client)
    started = start(cli)
    squashed = started["user_code"].replace("-", "").lower()

    res = admin_client.get("/api/device/pending", params={"code": squashed})
    assert res.status_code == 200, res.text
    assert res.json()["user_code"] == started["user_code"]


# ── 넘지 말아야 할 선 ────────────────────────────────────────────────────


def test_token_is_not_created_until_polled(admin_client):
    """승인만으로는 토큰이 생기지 않는다.

    원문은 생성 때 한 번만 나오는데 받아갈 쪽은 그 뒤에 온다 — 중간에 적어두면
    해싱이 의미를 잃는다. 그래서 '허락했다' 만 남기고 토큰은 폴링 때 만든다.
    """
    cli = bare(admin_client)
    started = start(cli)
    before = admin_client.get("/api/tokens").json()

    admin_client.post("/api/device/approve", json={"code": started["user_code"]})
    assert len(admin_client.get("/api/tokens").json()) == len(before), "승인만으로 토큰이 생겼다"

    assert poll(cli, started["device_code"]).status_code == 200
    assert len(admin_client.get("/api/tokens").json()) == len(before) + 1


def test_device_code_is_single_use(admin_client, monkeypatch):
    """한 번 받아가면 끝. 같은 device_code 로 토큰을 또 받아갈 수 없다."""
    monkeypatch.setattr(flow, "POLL_INTERVAL_SEC", 0)
    cli = bare(admin_client)
    started = start(cli)
    admin_client.post("/api/device/approve", json={"code": started["user_code"]})

    assert poll(cli, started["device_code"]).status_code == 200
    again = poll(cli, started["device_code"])
    assert again.status_code == 401
    assert again.json()["detail"]["error"] == "invalid_grant"


def test_user_code_alone_cannot_fetch_the_token(admin_client, monkeypatch):
    """**이게 코드를 둘로 가른 이유다.**

    어깨너머로 user_code 를 봐도 토큰은 못 받아간다 — 받으려면 터미널만 아는
    device_code 가 있어야 한다.
    """
    monkeypatch.setattr(flow, "POLL_INTERVAL_SEC", 0)
    cli = bare(admin_client)
    started = start(cli)
    admin_client.post("/api/device/approve", json={"code": started["user_code"]})

    stolen = poll(cli, started["user_code"])  # 공격자가 아는 건 이것뿐
    assert stolen.status_code == 401
    assert stolen.json()["detail"]["error"] == "invalid_grant"
    # 진짜 주인은 여전히 받아간다
    assert poll(cli, started["device_code"]).status_code == 200


def test_denied_tells_the_terminal_to_stop(admin_client, monkeypatch):
    monkeypatch.setattr(flow, "POLL_INTERVAL_SEC", 0)
    cli = bare(admin_client)
    started = start(cli)
    assert admin_client.post(
        "/api/device/deny", json={"code": started["user_code"]}
    ).status_code == 200

    res = poll(cli, started["device_code"])
    assert res.status_code == 400
    assert res.json()["detail"]["error"] == "access_denied"


def _age_out(client, user_code):
    """만료 시각을 과거로 당긴다 — 시계를 돌리는 대신 데이터를 늙힌다.

    test_trash.py 가 보존기간 테스트에서 쓰는 수법과 같다.
    """
    SessionLocal = client.app.state.sessionmaker
    with SessionLocal() as db:
        row = db.scalar(select(DeviceAuth).where(DeviceAuth.user_code == user_code))
        row.expires_at = utcnow() - timedelta(minutes=1)
        db.commit()


def test_expired_code_dies_everywhere(admin_client, monkeypatch):
    """10분이 지나면 죽는다 — 승인 화면에서도, 폴링에서도."""
    monkeypatch.setattr(flow, "POLL_INTERVAL_SEC", 0)
    cli = bare(admin_client)
    started = start(cli)
    _age_out(admin_client, started["user_code"])

    res = poll(cli, started["device_code"])
    assert res.status_code == 400
    assert res.json()["detail"]["error"] == "expired_token"

    # 승인 화면에서도 만료라고 말해줘야 한다 — 조용히 '없음' 이면 사람이 오타를 의심한다
    shown = admin_client.get("/api/device/pending", params={"code": started["user_code"]})
    assert shown.status_code == 410
    assert "만료" in shown.json()["detail"]


def test_approved_but_expired_still_hands_out_nothing(admin_client, monkeypatch):
    """승인까지 받았어도 만료됐으면 토큰은 없다 — 승인은 영수증이 아니다."""
    monkeypatch.setattr(flow, "POLL_INTERVAL_SEC", 0)
    cli = bare(admin_client)
    started = start(cli)
    admin_client.post("/api/device/approve", json={"code": started["user_code"]})
    _age_out(admin_client, started["user_code"])

    res = poll(cli, started["device_code"])
    assert res.status_code == 400
    assert res.json()["detail"]["error"] == "expired_token"


def test_purge_expired_cleans_up(admin_client):
    """만료된 건을 쌓아둘 이유가 없다."""
    cli = bare(admin_client)
    started = start(cli)
    _age_out(admin_client, started["user_code"])

    SessionLocal = admin_client.app.state.sessionmaker
    with SessionLocal() as db:
        assert flow.purge_expired(db) == 1
        db.commit()
        assert db.scalar(select(DeviceAuth).where(
            DeviceAuth.user_code == started["user_code"])) is None


def test_polling_too_fast_gets_slow_down(admin_client):
    """간격을 안 지키면 slow_down. 미인증 엔드포인트라 서버를 지켜야 한다."""
    cli = bare(admin_client)
    started = start(cli)

    first = poll(cli, started["device_code"])
    assert first.json()["detail"]["error"] == "authorization_pending"
    second = poll(cli, started["device_code"])  # 곧바로 다시
    assert second.json()["detail"]["error"] == "slow_down"


def test_unknown_device_code_is_rejected(admin_client):
    cli = bare(admin_client)
    assert poll(cli, "fsd_deadbeef.nope").status_code == 401
    assert poll(cli, "그냥아무거나").status_code == 401


def test_approval_requires_login(admin_client):
    """승인은 **로그인한 사람만** 한다. 여기서 '누가' 가 정해지고 토큰 주인이 된다."""
    cli = bare(admin_client)
    started = start(cli)
    assert cli.get("/api/device/pending", params={"code": started["user_code"]}).status_code == 401
    assert cli.post("/api/device/approve", json={"code": started["user_code"]}).status_code == 401


def test_scope_is_chosen_by_the_approver(admin_client, monkeypatch):
    """범위는 **승인하는 사람이** 정한다. 터미널이 요구할 수 없다.

    /code 요청 본문엔 범위를 넣을 자리가 아예 없다 — 넣어 보내도 무시된다.
    """
    monkeypatch.setattr(flow, "POLL_INTERVAL_SEC", 0)
    cli = bare(admin_client)
    spaces = spaces_of(admin_client)
    org = spaces["org"]

    # 터미널이 '전체 공간 달라' 고 우겨봐도 반영될 곳이 없다
    res = cli.post("/api/device/code", json={"client_name": "sneaky", "space_id": org["id"]})
    started = res.json()
    admin_client.post("/api/device/approve", json={"code": started["user_code"]})  # 범위 지정 없음

    token = poll(cli, started["device_code"]).json()["token"]
    listed = cli.get("/api/spaces", headers={"Authorization": f"Bearer {token}"}).json()
    # 기본값 = 개인 공간. 전체 공간이 아니다.
    assert [s["type"] for s in listed] == ["personal"]


def test_approver_can_narrow_scope_to_a_folder(admin_client, monkeypatch):
    monkeypatch.setattr(flow, "POLL_INTERVAL_SEC", 0)
    cli = bare(admin_client)
    pid = spaces_of(admin_client)["personal"]["id"]
    folder = admin_client.post("/api/nodes", json={"space_id": pid, "name": "배포함"}).json()
    admin_client.post(
        f"/api/nodes/{folder['id']}/files",
        files={"file": ("안.txt", io.BytesIO(b"in"), "text/plain")},
    )

    started = start(cli, "ci-runner")
    assert admin_client.post(
        "/api/device/approve",
        json={"code": started["user_code"], "node_id": folder["id"], "days": 7},
    ).status_code == 200

    token = poll(cli, started["device_code"]).json()["token"]
    auth = {"Authorization": f"Bearer {token}"}
    assert cli.get(f"/api/nodes/{folder['id']}/children", headers=auth).status_code == 200
    # 폴더 범위 토큰은 공간 최상위를 못 본다(#185 에서 그은 선)
    assert cli.get(f"/api/spaces/{pid}/children", headers=auth).status_code == 403


def test_issue_is_rate_limited_per_ip(admin_client, monkeypatch):
    """발급 자체에 상한 — 인증 없이 열린 문이라 무한정 찍어낼 수 없어야 한다."""
    monkeypatch.setattr(flow, "_ISSUE_MAX", 3)
    flow._issues.clear()
    cli = bare(admin_client)

    for _ in range(3):
        assert cli.post("/api/device/code", json={}).status_code == 201
    blocked = cli.post("/api/device/code", json={})
    assert blocked.status_code == 429
    assert blocked.json()["detail"]["error"] == "slow_down"
    flow._issues.clear()


def test_approval_screen_shows_what_is_being_approved(admin_client):
    """피싱을 사람이 알아채려면 **무엇을 허락하는지** 가 보여야 한다."""
    cli = bare(admin_client)
    started = start(cli, "누군가의-노트북")

    shown = admin_client.get("/api/device/pending", params={"code": started["user_code"]}).json()
    assert shown["client_name"] == "누군가의-노트북"
    assert "client_ip" in shown
    assert shown["created_at"] and shown["expires_at"]
