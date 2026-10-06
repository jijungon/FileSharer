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


# ── 오류 메시지 (사용자가 '버그인가?' 하고 헷갈렸던 자리) ────────────────────


def test_error_lists_contents_and_scope_hint(client, tmp_path, monkeypatch, capsys):
    module = load_served_cli(client, tmp_path)
    monkeypatch.setattr(module, "spaces", lambda *a, **k: [{"id": "s1", "name": "내 공간"}])
    monkeypatch.setattr(
        module, "children", lambda *a, **k: [{"id": "n1", "name": "보고서.md", "type": "file"}]
    )

    with pytest.raises(SystemExit):
        module.resolve("https://x.test", "t", "내 공간/IDP/x.md")
    err = capsys.readouterr().err

    assert "'IDP'" in err
    assert "여기 있는 것" in err and "보고서.md" in err
    # 첫 칸에서 틀렸고 쓸 수 있는 공간이 하나뿐 → 다른 공간 이름을 적었을 가능성이 크다
    assert "범위를 넓히세요" in err


def test_scope_hint_only_when_it_helps(client, tmp_path, monkeypatch, capsys):
    """두 번째 칸부터는 공간 이야기가 아니다 — 거기서 범위 안내를 하면 헛다리다."""
    module = load_served_cli(client, tmp_path)
    monkeypatch.setattr(module, "spaces", lambda *a, **k: [{"id": "s1", "name": "내 공간"}])
    calls = {"n": 0}

    def fake_children(*a, **k):
        calls["n"] += 1
        return [{"id": "f1", "name": "보관함", "type": "folder"}] if calls["n"] == 1 else []

    monkeypatch.setattr(module, "children", fake_children)

    with pytest.raises(SystemExit):
        module.resolve("https://x.test", "t", "내 공간/보관함/없는것.md")
    err = capsys.readouterr().err
    assert "'내 공간/보관함' 안에" in err
    assert "(비어 있음)" in err
    assert "범위를 넓히세요" not in err


@pytest.mark.parametrize(
    "name, expected",
    [
        ("문서함", "이"),  # ㅁ 받침
        ("백업", "이"),  # ㅂ 받침
        ("보고서", "가"),  # 받침 없음
        ("IDP", "가"),  # 피
        ("TEAM", "이"),  # 엠
        ("z", "가"),  # 제트
        ("2025", "가"),  # 오
        ("v1.0", "이"),  # 영
        ("보고서.md", "가"),  # 디 — 확장자까지 보고 읽는다
    ],
)
def test_josa_follows_the_name(client, tmp_path, name, expected):
    """'(을)를' 로 피하면 틀리진 않지만 공문서 투다. 웹(lib/josa.ts)과 같은 규칙."""
    module = load_served_cli(client, tmp_path)
    assert module.josa(name, "이", "가") == expected


def test_repeated_segment_reports_the_right_depth(client, tmp_path, monkeypatch, capsys):
    """``a/b/a`` 처럼 같은 이름이 두 번 나오면 index() 는 첫 자리를 가리킨다 — 틀린 위치다."""
    module = load_served_cli(client, tmp_path)
    monkeypatch.setattr(module, "spaces", lambda *a, **k: [{"id": "s1", "name": "내 공간"}])
    calls = {"n": 0}

    def fake_children(*a, **k):
        calls["n"] += 1
        return [{"id": "f1", "name": "작업", "type": "folder"}] if calls["n"] == 1 else []

    monkeypatch.setattr(module, "children", fake_children)

    with pytest.raises(SystemExit):
        module.resolve("https://x.test", "t", "내 공간/작업/작업")
    err = capsys.readouterr().err
    assert "'내 공간/작업' 안에" in err, err  # '내 공간' 이 아니라


def test_get_offers_both_ways_out(client, tmp_path):
    """덮어쓰기만 알려주면 원본을 날릴 각오를 해야 한다 — 다른 데 받는 길도 같이."""
    src = (tmp_path / "filesharer.py")
    src.write_text(fetch(client, "/cli/filesharer"), encoding="utf-8")
    text = src.read_text("utf-8")
    assert "-o 받을위치" in text and "--force" in text


def test_whoami_asks_the_server_who_this_token_is(client, tmp_path, monkeypatch, capsys):
    """'whoami' 인데 '누구' 가 빠져 있었다 — 기기 이름만 보여줬다.

    기기(ubuntu@호스트)는 **어디서** 지 **누구** 가 아니다. 토큰은 승인한 브라우저
    세션의 계정을 물려받으므로, 틀린 계정으로 붙어도 터미널에서는 알 길이 없었다.
    """
    module = load_served_cli(client, tmp_path)
    cfg = tmp_path / "config.json"
    cfg.write_text(
        '{"server": "https://x.test", "token": "fsk_a.b", "label": "ubuntu@bastion"}',
        encoding="utf-8",
    )
    monkeypatch.setattr(module, "CONFIG_PATH", cfg)

    def fake_request(server, path, **kwargs):
        if path == "/api/me":
            return 200, {"email": "joji@parametacorp.com", "name": "joji", "role": "user"}
        if path == "/api/spaces":
            return 200, [{"id": "s1", "name": "내 공간"}]
        raise AssertionError(path)

    monkeypatch.setattr(module, "request", fake_request)

    class Args:
        server = None

    assert module.cmd_whoami(Args()) == 0
    out = capsys.readouterr().out
    assert "계정" in out and "joji@parametacorp.com" in out
    # 계정이 맨 위여야 한다 — whoami 가 답해야 할 질문이다
    assert out.index("joji@parametacorp.com") < out.index("ubuntu@bastion")


def test_whoami_survives_a_server_that_wont_say(client, tmp_path, monkeypatch, capsys):
    """계정을 못 받아도 나머지는 보여준다 — whoami 가 통째로 죽으면 더 답답하다."""
    module = load_served_cli(client, tmp_path)
    cfg = tmp_path / "config.json"
    cfg.write_text('{"server": "https://x.test", "token": "t", "label": "box"}', encoding="utf-8")
    monkeypatch.setattr(module, "CONFIG_PATH", cfg)
    monkeypatch.setattr(
        module,
        "request",
        lambda server, path, **k: (200, [{"id": "s", "name": "내 공간"}])
        if path == "/api/spaces"
        else (500, None),
    )

    class Args:
        server = None

    assert module.cmd_whoami(Args()) == 0
    out = capsys.readouterr().out
    assert "확인 못 함" in out and "box" in out


# ── 자체 업데이트 ───────────────────────────────────────────────────────


def test_version_endpoint_matches_what_is_served(client, tmp_path):
    """``/cli/version`` 은 **지금 내주는 그 CLI** 의 버전이어야 한다.

    어긋나면 '새 버전이 있다' 고 해놓고 받아보면 같은 것이 오는, 영원히 안 끝나는
    업데이트가 된다.
    """
    served = load_served_cli(client, tmp_path)
    reported = client.get("/cli/version").json()["version"]
    assert reported == served.CLI_VERSION


def test_comparison_uses_the_hash_not_the_app_version(client, tmp_path):
    """'낡았나' 는 **소스 해시**로 가린다.

    앱 버전(v1.0.x)으로 가리면 CLI 와 무관한 백엔드 배포마다 '새 버전' 이 뜨고,
    몇 번 겪으면 아무도 안 읽는 알림이 된다.
    """
    module = load_served_cli(client, tmp_path)
    assert len(module.CLI_VERSION) == 12
    assert all(c in "0123456789abcdef" for c in module.CLI_VERSION)
    assert client.get("/cli/version").json()["version"] == module.CLI_VERSION


def test_what_people_see_is_the_app_version(client, tmp_path):
    """**보여주는 건 사람이 비교할 수 있는 값이어야 한다.**

    해시(4e34571df821)를 --version 에 찍었더니 "이 버전이 왜 이렇게 나오냐" 는 말을
    들었다. 화면 어디에도 안 나오는 숫자라 새 건지 낡은 건지 알 길이 없다.
    뒤의 짧은 해시는 '정확히 어느 사본인가' 를 물을 때를 위해 남긴다.
    """
    module = load_served_cli(client, tmp_path)
    label = module.version_label()

    assert label.startswith("v") or label.startswith("dev"), label
    assert module.CLI_VERSION[:8] in label, "어느 사본인지도 알 수 있어야 한다"
    assert module.CLI_VERSION not in label, "전체 해시까지 보여줄 필요는 없다"

    served_app = client.get("/cli/version").json()["app_version"]
    assert served_app in label


def test_update_does_not_redownload_when_only_the_app_version_moved(
    client, tmp_path, monkeypatch, capsys
):
    """서버는 내줄 때 주소·버전을 박아 넣는다 — CLI 가 한 글자도 안 바뀐 배포에서도
    **본문은 달라진다.** 본문으로 비교하면 매번 20KB 를 받아 부질없이 갈아끼운다.
    """
    module = load_served_cli(client, tmp_path)
    target = tmp_path / "filesharer"
    target.write_text("#!/usr/bin/env python3\n" + "# 아무거나\n" * 400, encoding="utf-8")
    monkeypatch.setattr(module.sys, "argv", [str(target)])
    # 해시는 같고 앱 버전만 올라간 상황
    monkeypatch.setattr(
        module, "server_cli_version", lambda *a, **k: (module.CLI_VERSION, "v9.9.9")
    )

    def boom(*a, **k):
        raise AssertionError("해시가 같은데 본문을 받으러 갔다")

    monkeypatch.setattr(module, "request", boom)

    class Args:
        server = "https://x.test"
        force = False

    assert module.cmd_update(Args()) == 0
    assert "이미 최신입니다" in capsys.readouterr().out


def test_update_refuses_anything_that_is_not_the_cli(client, tmp_path, monkeypatch):
    """**사내 프록시·캡티브 포털이 HTML 안내 페이지를 200 으로 주는 일이 흔하다.**

    그걸 그대로 덮어쓰면 CLI 가 통째로 망가지고, 고치려 해도 update 조차 못 돈다.
    """
    module = load_served_cli(client, tmp_path)
    target = tmp_path / "filesharer"
    original = "#!/usr/bin/env python3\n" + "# 진짜 CLI 입니다 — 길이를 채운다\n" * 400
    target.write_text(original, encoding="utf-8")
    target.chmod(0o755)
    monkeypatch.setattr(module.sys, "argv", [str(target)])

    for payload in (
        b"<html><body>Captive portal</body></html>",
        b"",
        b"#!/usr/bin/env python3\nprint('hi')\n",  # 파이썬이지만 너무 짧다
    ):
        monkeypatch.setattr(module, "request", lambda *a, _p=payload, **k: (200, _p))

        class Args:
            server = "https://x.test"
            force = True  # 해시 비교를 건너뛰고 받아오는 경로를 본다

        with pytest.raises(SystemExit):
            module.cmd_update(Args())
        assert target.read_text("utf-8") == original, "거부했는데 파일이 바뀌었다"


def test_update_replaces_itself_and_keeps_the_mode(client, tmp_path, monkeypatch, capsys):
    module = load_served_cli(client, tmp_path)
    target = tmp_path / "filesharer"
    target.write_text(
        "#!/usr/bin/env python3\n" + "# 옛것 — 길이를 채운다\n" * 400, encoding="utf-8"
    )
    target.chmod(0o755)
    monkeypatch.setattr(module.sys, "argv", [str(target)])
    monkeypatch.setattr(module, "CONFIG_PATH", tmp_path / "config.json")

    fresh = "#!/usr/bin/env python3\n" + "# 새것 — 길이를 채운다\n" * 400
    monkeypatch.setattr(module, "request", lambda *a, **k: (200, fresh.encode("utf-8")))

    class Args:
        server = "https://x.test"
        force = True

    assert module.cmd_update(Args()) == 0
    assert target.read_text("utf-8") == fresh
    # 실행 권한을 잃으면 다음부터 못 돈다
    assert target.stat().st_mode & 0o111, "실행 권한이 사라졌다"
    assert "새 CLI 로 바꿨습니다" in capsys.readouterr().out


def test_stale_nudge_is_once_a_day_and_never_blocks(client, tmp_path, monkeypatch, capsys):
    """확인에 실패해도 하려던 일은 그대로 돼야 한다 — 본말이 전도되면 안 된다."""
    module = load_served_cli(client, tmp_path)
    cfg = tmp_path / "config.json"
    cfg.write_text('{"server": "https://x.test", "token": "t"}', encoding="utf-8")
    monkeypatch.setattr(module, "CONFIG_PATH", cfg)
    monkeypatch.setattr(module, "server_cli_version", lambda *a, **k: ("다른버전", "v9.9.9"))

    class Args:
        server = None
        cmd = "ls"

    module.nudge_if_stale(Args())
    assert "새 CLI 가 있습니다" in capsys.readouterr().err

    # 곧바로 또 부르면 조용하다(하루 한 번)
    module.nudge_if_stale(Args())
    assert capsys.readouterr().err == ""

    # 서버에 못 물어봐도 터지지 않는다
    cfg.write_text('{"server": "https://x.test"}', encoding="utf-8")
    monkeypatch.setattr(module, "server_cli_version", lambda *a, **k: (None, None))
    module.nudge_if_stale(Args())
    assert capsys.readouterr().err == ""
