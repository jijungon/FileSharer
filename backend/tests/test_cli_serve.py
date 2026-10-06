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
