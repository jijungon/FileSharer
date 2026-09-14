"""원커맨드(/get) — 스크립트 렌더 검증 + (리눅스 CI) alpine 컨테이너 실전 스모크."""

import io
import os
import shutil
import socket
import subprocess
import sys
import time
from pathlib import Path

import httpx
import pytest


def upload(client, url, name, content=b"hello"):
    return client.post(url, files={"file": (name, io.BytesIO(content), "text/plain")})


def personal_space(client):
    return next(s for s in client.get("/api/spaces").json() if s["type"] == "personal")


def test_get_script_renders_for_file(admin_client):
    sp = personal_space(admin_client)
    node = upload(admin_client, f"/api/spaces/{sp['id']}/files", "받기.txt", b"cli!").json()
    share = admin_client.post(f"/api/nodes/{node['id']}/shares", json={}).json()

    admin_client.post("/api/auth/logout")
    res = admin_client.get(f"/s/{share['token']}/get")
    assert res.status_code == 200
    assert res.headers["content-type"].startswith("text/x-sh")
    body = res.text
    assert share["token"] in body
    assert 'TYPE="file"' in body
    assert 'NAME="받기.txt"' in body
    assert "sha256" in body


def test_get_script_renders_for_folder(admin_client):
    sp = personal_space(admin_client)
    folder = admin_client.post(
        "/api/nodes", json={"space_id": sp["id"], "name": "번들"}
    ).json()
    share = admin_client.post(f"/api/nodes/{folder['id']}/shares", json={}).json()
    res = admin_client.get(f"/s/{share['token']}/get")
    assert 'TYPE="folder"' in res.text
    assert "fetch tar" in res.text  # 폴더는 tar 경로로 받는다


def test_get_script_gone_when_expired(admin_client, db):
    from datetime import timedelta

    from app.models import ShareLink, utcnow

    sp = personal_space(admin_client)
    node = upload(admin_client, f"/api/spaces/{sp['id']}/files", "x.txt").json()
    share = admin_client.post(f"/api/nodes/{node['id']}/shares", json={}).json()
    row = db.get(ShareLink, share["id"])
    row.expires_at = utcnow() - timedelta(days=1)
    db.commit()
    assert admin_client.get(f"/s/{share['token']}/get").status_code == 410


# ---------- 원커맨드 실전 스모크 (curl·tar·sh만으로 — 완료 기준: VM에서 한 줄) ----------
# docker 없이 로컬 sh로 실제 /get 스크립트를 실행한다. curl/tar/sh만 있으면 되며
# (mac·linux 공통), --network host 같은 불안정 요소가 없어 flaky하지 않다.

pytestmark_cli = pytest.mark.skipif(
    shutil.which("curl") is None or shutil.which("tar") is None,
    reason="curl·tar 필요",
)


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _wait_healthy(base: str, timeout: float = 30.0) -> None:
    """서버가 실제로 200을 줄 때까지 대기(항상 sleep). 시간 초과면 명확히 실패."""
    deadline = time.monotonic() + timeout
    last = ""
    with httpx.Client(base_url=base, timeout=3) as c:
        while time.monotonic() < deadline:
            try:
                if c.get("/api/health").status_code == 200:
                    return
                last = "non-200"
            except httpx.HTTPError as e:
                last = repr(e)
            time.sleep(0.25)
    raise AssertionError(f"server not healthy within {timeout}s ({last})")


@pytestmark_cli
def test_one_command_end_to_end(tmp_path):
    """실제 uvicorn + 렌더된 /get 스크립트를 sh로 실행 — 파일/폴더/비밀번호 전 분기."""
    port = _free_port()
    base = f"http://127.0.0.1:{port}"
    env = {
        **os.environ,
        "APP_ENV": "test",
        "SECRET_KEY": "cli-smoke-secret",
        "DATA_DIR": str(tmp_path / "data"),
        "DATABASE_URL": f"sqlite:///{tmp_path / 'cli.db'}",
        "BASE_URL": base,
        "FRONTEND_URL": "",
        "ADMIN_EMAIL": "cli@test.local",
        "ADMIN_PASSWORD": "cli-pass-123",
        "GOOGLE_CLIENT_ID": "",
        "GOOGLE_CLIENT_SECRET": "",
        "FILESHARER_ENV_FILE": str(tmp_path / "none.env"),
    }
    backend_dir = Path(__file__).resolve().parent.parent
    server = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "app.main:app", "--port", str(port)],
        cwd=backend_dir,
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.STDOUT,
    )
    try:
        _wait_healthy(base)
        with httpx.Client(base_url=base, timeout=10) as c:
            c.post(
                "/api/auth/login",
                json={"email": "cli@test.local", "password": "cli-pass-123"},
            ).raise_for_status()
            sp = next(s for s in c.get("/api/spaces").json() if s["type"] == "personal")

            bin_payload = ("모델.bin", io.BytesIO(b"MODEL-BYTES"), "application/octet-stream")
            r = c.post(f"/api/spaces/{sp['id']}/files", files={"file": bin_payload})
            r.raise_for_status()
            fshare = c.post(f"/api/nodes/{r.json()['id']}/shares", json={})
            fshare.raise_for_status()
            ftok = fshare.json()["token"]

            folder = c.post("/api/nodes", json={"space_id": sp["id"], "name": "배포셋"})
            folder.raise_for_status()
            c.post(
                f"/api/nodes/{folder.json()['id']}/files",
                files={"file": ("config.yml", io.BytesIO(b"k: v"), "text/plain")},
            ).raise_for_status()
            dshare = c.post(f"/api/nodes/{folder.json()['id']}/shares", json={})
            dshare.raise_for_status()
            dtok = dshare.json()["token"]

            pnode = c.post(
                f"/api/spaces/{sp['id']}/files",
                files={"file": ("비밀.txt", io.BytesIO(b"SECRET-BYTES"), "text/plain")},
            )
            pnode.raise_for_status()
            pshare = c.post(
                f"/api/nodes/{pnode.json()['id']}/shares", json={"password": "opensesame"}
            )
            pshare.raise_for_status()
            ptok = pshare.json()["token"]

        work = tmp_path / "work"
        work.mkdir()

        def run_get(token, *extra, share_pw=None):
            # curl <base>/s/<token>/get | [SHARE_PW=..] sh -s -- <extra>  를 sh로 실행
            pw = f"SHARE_PW={share_pw} " if share_pw is not None else ""
            cmd = f"curl -fsSL {base}/s/{token}/get | {pw}sh -s -- {' '.join(extra)}"
            return subprocess.run(
                ["sh", "-c", cmd],
                cwd=work,
                capture_output=True,
                text=True,
                timeout=60,
                stdin=subprocess.DEVNULL,
                start_new_session=True,  # 제어 터미널 분리 → /dev/tty 못 열어 프롬프트로 안 멈춤
            )

        # 1) 파일: 그냥 받기
        assert run_get(ftok).returncode == 0
        assert (work / "모델.bin").read_bytes() == b"MODEL-BYTES"

        # 2) 폴더: -C 대상 디렉토리로 tar 해제
        assert run_get(dtok, "-C", "받은폴더").returncode == 0
        assert (work / "받은폴더" / "배포셋" / "config.yml").read_bytes() == b"k: v"

        # 3) 비번 링크, 비번 없이(비대화형) → 실패 + 안내
        no_pw = run_get(ptok)
        assert no_pw.returncode != 0
        assert "비밀번호" in (no_pw.stdout + no_pw.stderr)

        # 4) 비번 링크, 틀린 비번 → 실패(401)
        assert run_get(ptok, "-C", "틀림", share_pw="nope").returncode != 0

        # 5) 비번 링크, 올바른 SHARE_PW(sh쪽) → 수신
        ok = run_get(ptok, "-C", "비번폴더", share_pw="opensesame")
        assert ok.returncode == 0, f"stdout={ok.stdout}\nstderr={ok.stderr}"
        assert (work / "비번폴더" / "비밀.txt").read_bytes() == b"SECRET-BYTES"
        assert "ok: sha256" in ok.stdout
    finally:
        server.terminate()
        server.wait(timeout=10)


def test_get_script_protected_flag_and_prompt(admin_client):
    """비번 링크의 /get 스크립트는 PROTECTED=1 이고 /dev/tty 프롬프트 로직을 포함한다."""
    sp = personal_space(admin_client)
    node = upload(admin_client, f"/api/spaces/{sp['id']}/files", "비밀.txt", b"x").json()
    share = admin_client.post(
        f"/api/nodes/{node['id']}/shares", json={"password": "pw123"}
    ).json()
    admin_client.post("/api/auth/logout")
    body = admin_client.get(f"/s/{share['token']}/get").text
    assert 'PROTECTED="1"' in body
    assert "/dev/tty" in body
    assert "__PROTECTED__" not in body


def test_get_script_unprotected_flag(admin_client):
    sp = personal_space(admin_client)
    node = upload(admin_client, f"/api/spaces/{sp['id']}/files", "공개.txt", b"y").json()
    share = admin_client.post(f"/api/nodes/{node['id']}/shares", json={}).json()
    body = admin_client.get(f"/s/{share['token']}/get").text
    assert 'PROTECTED="0"' in body
