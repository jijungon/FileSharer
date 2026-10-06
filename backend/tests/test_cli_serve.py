"""서버가 내주는 CLI — 받아서 바로 돌아가는지.

파일이 '있는지' 가 아니라 **내준 그 사본이 동작하는지** 를 본다. 실제로 원본은 멀쩡한데
내준 사본만 고장 난 적이 있다(아래 자리표시자 테스트).
"""

import importlib.util
import sys
from pathlib import Path

import pytest


def fetch(client, path: str) -> str:
    res = client.get(path)
    assert res.status_code == 200, res.text
    return res.text


def load_served_cli(client, tmp_path: Path):
    """내준 사본을 **파이썬으로 실제 불러온다.** 문자열만 보면 놓치는 게 있다."""
    src = fetch(client, "/cli/filesharer")
    mod_path = tmp_path / "served_filesharer.py"
    mod_path.write_text(src, encoding="utf-8")
    spec = importlib.util.spec_from_file_location("served_filesharer", mod_path)
    module = importlib.util.module_from_spec(spec)
    sys.modules["served_filesharer"] = module
    spec.loader.exec_module(module)
    return module


def test_install_script_is_a_shell_script(client):
    body = fetch(client, "/cli/install.sh")
    assert body.startswith("#!/bin/sh")
    assert "set -eu" in body
    # 받다 만 파일이 실행 권한을 달고 남으면 안 된다 — 다 받은 뒤에 옮긴다
    assert ".part$$" in body and "mv " in body
    # python3 가 없으면 설치부터 멈춰야 한다(나중에 '명령을 못 찾겠다' 보다 낫다)
    assert "python3" in body


def test_cli_is_importable_python(client, tmp_path):
    module = load_served_cli(client, tmp_path)
    assert hasattr(module, "main")
    for cmd in ("login", "logout", "whoami", "ls", "put", "get"):
        assert hasattr(module, f"cmd_{cmd}") or cmd in ("logout",)


def test_served_copy_knows_its_server(client, tmp_path, monkeypatch):
    """**이 테스트가 잡은 버그**: 자리표시자를 전부 치환하면 CLI 안의

        if raw == "__FILESHARER_SERVER__"

    비교문까지 같이 바뀌어, 주소를 제대로 찾고도 "서버 주소를 모릅니다" 로 멈춘다.
    원본은 멀쩡해서 파일만 봐서는 안 보이고, **내준 사본을 실행해야** 드러난다.
    """
    module = load_served_cli(client, tmp_path)
    monkeypatch.delenv("FILESHARER_SERVER", raising=False)
    monkeypatch.setattr(module, "CONFIG_PATH", tmp_path / "없는설정.json")

    class Args:
        server = None

    resolved = module.server_of(Args())
    assert resolved.startswith("http")
    assert "__FILESHARER" not in resolved


def test_install_script_points_at_the_same_server(client):
    install = fetch(client, "/cli/install.sh")
    assert "__FILESHARER_SERVER__" not in install
    assert "/cli/filesharer" in install


def test_cli_routes_do_not_swallow_the_spa_page(client):
    """``/cli`` 는 안내 **페이지**(SPA)고 ``/cli/install.sh`` 는 **파일**이다.

    접두사가 같아 한쪽이 다른 쪽을 삼키기 쉽다. 둘 다 제 몫을 하는지 본다.
    """
    assert client.get("/cli/install.sh").headers["content-type"].startswith("text/x-shellscript")
    assert client.get("/cli/filesharer").headers["content-type"].startswith("text/x-python")


@pytest.mark.parametrize(
    "items, to, files, dest",
    [
        # 마지막이 내 디스크에 없는 이름이면 '올릴 곳'
        (["a.txt", "내 공간/IDP"], None, ["a.txt"], "내 공간/IDP"),
        (["a.txt", "b.txt", "내 공간"], None, ["a.txt", "b.txt"], "내 공간"),
        # 하나뿐이면 그건 파일이다 — 경로로 오해하면 올릴 게 없어진다
        (["a.txt"], None, ["a.txt"], ""),
        # --to 가 있으면 위치 인자는 전부 파일
        (["a.txt", "b.txt"], "내 공간", ["a.txt", "b.txt"], "내 공간"),
    ],
)
def test_put_splits_files_from_destination(client, tmp_path, items, to, files, dest):
    """argparse 로는 못 가르는 자리다 — nargs='+' 가 올릴 곳까지 파일로 먹는다.

    실제로 "파일이 아닙니다: 내 공간" 이 났다.
    """
    module = load_served_cli(client, tmp_path)
    got_files, got_dest = module.split_put_args(items, to)
    assert [str(f) for f in got_files] == files
    assert got_dest == dest


def test_put_keeps_an_existing_last_arg_as_a_file(client, tmp_path):
    """마지막 인자가 **진짜 있는 파일**이면 올릴 곳이 아니라 올릴 것이다."""
    module = load_served_cli(client, tmp_path)
    real = tmp_path / "진짜.txt"
    real.write_text("x", encoding="utf-8")
    files, dest = module.split_put_args(["a.txt", str(real)], None)
    assert [str(f) for f in files] == ["a.txt", str(real)]
    assert dest == ""


def test_cli_identifies_itself(client, tmp_path):
    """**모든 요청에 User-Agent 를 단다.**

    안 달면 urllib 이 "Python-urllib/3.x" 를 쓰는데, 앞단에 Cloudflare 같은 게 있으면
    그 서명을 봇으로 보고 막는다. 실제로 프로덕션에서 `filesharer login` 이

        오류: The site owner has blocked access based on your browser's signature.

    로 죽었다(CF 오류 1010). curl 은 되고 urllib 만 안 되는, 서버 로그엔 안 남는 종류다.
    """
    module = load_served_cli(client, tmp_path)
    assert "Python-urllib" not in module.USER_AGENT
    assert module.USER_AGENT.startswith("filesharer")

    seen: dict = {}

    class FakeResponse:
        status = 200
        headers = {"Content-Type": "application/json"}

        def read(self):
            return b"[]"

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    def fake_urlopen(req, timeout=None):
        seen["ua"] = req.get_header("User-agent")
        return FakeResponse()

    module.urllib.request.urlopen = fake_urlopen
    module.request("https://example.test", "/api/spaces", token="t")
    assert seen["ua"] == module.USER_AGENT


def test_blocked_by_proxy_is_named_as_such(client, tmp_path):
    """앞단이 막은 걸 서버 오류처럼 보여주면, 사람은 제 계정·토큰을 의심하며 헤맨다."""
    module = load_served_cli(client, tmp_path)

    # Cloudflare 가 JSON 으로 돌려준 모양
    cf = module.blocked_hint(403, {"detail": "blocked access based on your browser's signature"})
    assert cf and "앞단" in cf

    # 본문이 HTML 이라 파싱도 안 되는 경우
    html = module.blocked_hint(403, b"<html>...</html>")
    assert html and "앞단" in html

    # 우리 서버가 제대로 낸 403 은 그대로 둔다 — 범위 밖이라는 말을 덮으면 안 된다
    assert module.blocked_hint(403, {"detail": "토큰 범위 밖의 공간입니다"}) is None
    assert module.blocked_hint(401, {"detail": "로그인이 필요합니다"}) is None
