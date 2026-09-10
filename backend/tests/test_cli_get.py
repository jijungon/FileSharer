"""원커맨드(/get) — 스크립트 렌더 검증 + (리눅스 CI) alpine 컨테이너 실전 스모크."""

import io
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
    assert "/tar" in res.text


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


# ---------- alpine 컨테이너 실전 스모크 (완료 기준: 깡통 VM에서 한 줄) ----------

pytestmark_docker = pytest.mark.skipif(
    sys.platform == "darwin" or shutil.which("docker") is None,
    reason="linux + docker 환경에서만 (CI에서 실행)",
)


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytestmark_docker
def test_one_command_in_bare_alpine(tmp_path):
    port = _free_port()
    env = {
        "PATH": "/usr/bin:/bin:/usr/local/bin",
        "APP_ENV": "test",
        "SECRET_KEY": "cli-smoke-secret",
        "DATA_DIR": str(tmp_path / "data"),
        "DATABASE_URL": f"sqlite:///{tmp_path / 'cli.db'}",
        "BASE_URL": f"http://127.0.0.1:{port}",
        "ADMIN_EMAIL": "cli@test.local",
        "ADMIN_PASSWORD": "cli-pass-123",
    }
    backend_dir = Path(__file__).resolve().parent.parent
    server = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", str(port)],
        cwd=backend_dir,
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.STDOUT,
    )
    try:
        with httpx.Client(base_url=f"http://127.0.0.1:{port}", timeout=10) as c:
            for _ in range(50):
                try:
                    if c.get("/api/health").status_code == 200:
                        break
                except httpx.HTTPError:
                    time.sleep(0.2)
            c.post(
                "/api/auth/login",
                json={"email": "cli@test.local", "password": "cli-pass-123"},
            ).raise_for_status()
            sp = next(s for s in c.get("/api/spaces").json() if s["type"] == "personal")
            # 파일 + 폴더(하위 파일 포함) 공유 준비
            payload = ("모델.bin", io.BytesIO(b"MODEL-BYTES"), "application/octet-stream")
            fnode = c.post(
                f"/api/spaces/{sp['id']}/files", files={"file": payload}
            ).json()
            fshare = c.post(f"/api/nodes/{fnode['id']}/shares", json={}).json()
            folder = c.post("/api/nodes", json={"space_id": sp["id"], "name": "배포셋"}).json()
            c.post(
                f"/api/nodes/{folder['id']}/files",
                files={"file": ("config.yml", io.BytesIO(b"k: v"), "text/plain")},
            )
            dshare = c.post(f"/api/nodes/{folder['id']}/shares", json={}).json()

        work = tmp_path / "work"
        work.mkdir()
        script = (
            "apk add -q curl >/dev/null && cd /work && "
            f"curl -fsSL http://127.0.0.1:{port}/s/{fshare['token']}/get | sh && "
            f"curl -fsSL http://127.0.0.1:{port}/s/{dshare['token']}/get | sh -s -- -C 받은폴더"
        )
        run = subprocess.run(
            [
                "docker", "run", "--rm", "--network", "host",
                "-v", f"{work}:/work", "alpine:3.20", "sh", "-c", script,
            ],
            capture_output=True,
            text=True,
            timeout=180,
        )
        assert run.returncode == 0, f"stdout={run.stdout}\nstderr={run.stderr}"
        assert (work / "모델.bin").read_bytes() == b"MODEL-BYTES"
        assert (work / "받은폴더" / "배포셋" / "config.yml").read_bytes() == b"k: v"
        assert "ok: sha256" in run.stdout
    finally:
        server.terminate()
        server.wait(timeout=10)
