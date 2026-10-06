#!/usr/bin/env python3
"""filesharer — FileSharer 명령줄 클라이언트.

**표준 라이브러리만 쓴다.** 이걸 돌릴 곳은 대개 사내 VM 이고, 거기에 pip 로 뭘 깔라고
하면 그 순간 "그냥 curl 쓸게" 가 된다. 받아서 바로 돌아가야 한다.

쉘이 아니라 파이썬인 이유: JSON 과 한글 파일 이름을 다뤄야 한다. 쉘로 하면 jq 가
있느냐 없느냐로 갈리고, 한글 이름에서 따옴표가 새기 시작하면 끝이 없다.

    filesharer login              브라우저로 로그인(터미널엔 코드만 뜬다)
    filesharer whoami             지금 누구로, 어디까지, 언제까지
    filesharer ls [경로]          둘러보기
    filesharer put <파일...> [경로]
    filesharer get <경로> [-o 저장위치]
    filesharer logout             이 기기의 자격을 지운다

경로는 사람이 읽는 그대로 쓴다 — ``내 공간/IDP/보고서.md``.
"""

from __future__ import annotations

import argparse
import json
import mimetypes
import os
import secrets
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from pathlib import Path

# 서버가 이 파일을 내줄 때 **이 한 줄만** 자기 주소로 바꿔 넣는다(api/cli.py 참고).
# 아래에서 '아직 안 채워졌나' 를 볼 때 자리표시자를 글자 그대로 또 쓰지 않는 이유:
# 그러면 치환이 그 비교문까지 같이 바꿔서, 주소를 제대로 찾고도 "모르겠다" 며 멈춘다.
# 실제로 그렇게 짰다가 서버에서 내준 사본에서만 터졌다.
DEFAULT_SERVER = "__FILESHARER_SERVER__"

CONFIG_DIR = Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config")) / "filesharer"
CONFIG_PATH = CONFIG_DIR / "config.json"

# **반드시 보낸다.** 안 보내면 urllib 이 "Python-urllib/3.x" 를 쓰는데, 앞단에 Cloudflare
# 같은 게 있으면 그 서명을 봇으로 보고 막는다 — 실제로 프로덕션에서 403(CF 오류 1010)이
# 났다. 우리 쪽 잘못이 아니라 '이름을 안 댄' 쪽 잘못이다. 자기 이름과 돌아올 주소를 댄다.
USER_AGENT = "filesharer-cli/1 (+https://github.com/jijungon/FileSharer)"


class Fail(SystemExit):
    """사람에게 보여줄 오류. 스택 트레이스 대신 한 줄로 말한다."""

    def __init__(self, message: str):
        print(f"오류: {message}", file=sys.stderr)
        super().__init__(1)


# ── 설정 ────────────────────────────────────────────────────────────────


def load_config() -> dict:
    try:
        return json.loads(CONFIG_PATH.read_text("utf-8"))
    except FileNotFoundError:
        return {}
    except json.JSONDecodeError:
        raise Fail(f"설정 파일이 깨졌습니다: {CONFIG_PATH} — 지우고 다시 login 하세요") from None


def save_config(cfg: dict) -> None:
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    # 토큰이 든 파일이다. 먼저 0600 으로 만들고 쓴다 — 만들고 나서 바꾸면 그 사이가 열려 있다.
    tmp = CONFIG_DIR / f".config.{secrets.token_hex(4)}.tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        json.dump(cfg, fh, ensure_ascii=False, indent=2)
    tmp.replace(CONFIG_PATH)


def _unfilled(value: str | None) -> bool:
    """아직 서버가 안 채운 자리표시자인가."""
    return not value or value.startswith("__")


def server_of(args) -> str:
    raw = args.server or os.environ.get("FILESHARER_SERVER") or load_config().get("server")
    if _unfilled(raw):
        raw = DEFAULT_SERVER
    if _unfilled(raw):
        raise Fail("서버 주소를 모릅니다 — --server 나 FILESHARER_SERVER 로 알려주세요")
    return raw.rstrip("/")


def token_of() -> str:
    tok = load_config().get("token")
    if not tok:
        raise Fail("로그인이 필요합니다 — filesharer login")
    return tok


# ── HTTP ────────────────────────────────────────────────────────────────


def request(
    server: str,
    path: str,
    *,
    method: str = "GET",
    json_body: dict | None = None,
    token: str | None = None,
    raw_body: bytes | None = None,
    content_type: str | None = None,
) -> tuple[int, object]:
    """(상태코드, 파싱된 본문). 4xx·5xx 도 예외로 던지지 않고 그대로 돌려준다 —
    디바이스 플로우는 400 이 정상 흐름의 일부라서(authorization_pending)."""
    url = server + path
    data = raw_body
    headers = {"Accept": "application/json", "User-Agent": USER_AGENT}
    if json_body is not None:
        data = json.dumps(json_body, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json"
    if content_type:
        headers["Content-Type"] = content_type
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=300) as res:
            return res.status, _parse(res.read(), res.headers.get("Content-Type", ""))
    except urllib.error.HTTPError as exc:
        return exc.code, _parse(exc.read(), exc.headers.get("Content-Type", ""))
    except urllib.error.URLError as exc:
        raise Fail(f"{server} 에 닿지 못했습니다 — {exc.reason}") from None


def _parse(body: bytes, ctype: str) -> object:
    if "json" in ctype:
        try:
            return json.loads(body.decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError):
            return None
    return body


def detail_of(body: object, fallback: str) -> str:
    if isinstance(body, dict):
        d = body.get("detail")
        if isinstance(d, str):
            return d
        if isinstance(d, dict) and "error" in d:
            return str(d["error"])
    return fallback


def blocked_hint(status: int, body: object) -> str | None:
    """앞단(CDN·WAF)이 막은 것 같으면 그렇게 말해준다.

    서버가 준 오류와 구분이 안 되면 사람은 자기 계정이나 토큰을 의심하며 헤맨다.
    403 인데 우리 서버의 JSON 오류 모양이 아니면 중간에서 끊긴 것이다.
    """
    if status != 403:
        return None
    if isinstance(body, dict) and isinstance(body.get("detail"), str):
        text = body["detail"]
        if "signature" in text or "blocked" in text or "1010" in text:
            return f"앞단에서 차단됐습니다 — {text}"
        return None
    return "앞단(CDN·방화벽)에서 차단된 것 같습니다 — 서버가 아니라 중간에서 끊겼습니다"


# ── login ───────────────────────────────────────────────────────────────


def cmd_login(args) -> int:
    server = server_of(args)
    name = args.name or _default_device_name()

    status, body = request(
        server, "/api/device/code", method="POST", json_body={"client_name": name}
    )
    if status != 201 or not isinstance(body, dict):
        raise Fail(
            blocked_hint(status, body) or detail_of(body, f"코드를 받지 못했습니다 (HTTP {status})")
        )

    uri, code = body["verification_uri"], body["user_code"]
    # 브라우저가 있으면 열어준다. **없어도 되는 게 핵심이다** — SSH 로 들어온 VM 에는
    # 브라우저가 없고, 그래서 주소와 코드를 항상 글자로도 찍는다.
    # flush 하는 이유: 바로 아래에서 폴링 루프로 들어가 잠든다. 파이썬은 출력이
    # 터미널이 아니면 버퍼에 쌓아두므로(`filesharer login | tee log` 같은 경우),
    # **사람이 옮겨 적어야 할 코드가 화면에 안 나온 채로** 기다리게 된다.
    print(f"\n  브라우저에서 열어주세요:  {uri}\n  코드를 입력하세요:        {code}\n", flush=True)
    opened = False
    if not args.no_browser:
        try:
            opened = webbrowser.open(body.get("verification_uri_complete") or uri)
        except Exception:
            opened = False
    if opened:
        print("  (브라우저를 열었습니다. 안 떴으면 위 주소를 직접 여세요.)", flush=True)
    print("  승인을 기다리는 중…  [Ctrl-C 로 취소]", flush=True)

    interval = int(body.get("interval", 5))
    deadline = time.time() + int(body.get("expires_in", 600))
    device_code = body["device_code"]

    while time.time() < deadline:
        time.sleep(interval)
        status, got = request(
            server, "/api/device/token", method="POST", json_body={"device_code": device_code}
        )
        if status == 200 and isinstance(got, dict):
            cfg = load_config()
            cfg.update(
                {
                    "server": server,
                    "token": got["token"],
                    "token_id": got.get("token_id", ""),
                    "label": got.get("label", name),
                    "expires_at": got.get("expires_at"),
                }
            )
            save_config(cfg)
            print()
            print(f"  ✓ 로그인했습니다 — {cfg['label']}")
            print(f"    자격은 {CONFIG_PATH} 에 두었습니다 (이 사용자만 읽을 수 있음)")
            if cfg.get("expires_at"):
                print(f"    만료 {cfg['expires_at'][:10]} · 웹에서 언제든 회수할 수 있습니다")
            return 0

        err = detail_of(got, "")
        if err == "authorization_pending":
            continue
        if err == "slow_down":
            interval += 5  # 서버가 천천히 오라고 하면 그렇게 한다
            continue
        if err == "access_denied":
            raise Fail("승인이 거부됐습니다")
        if err == "expired_token":
            raise Fail("코드가 만료됐습니다 — 다시 login 하세요")
        raise Fail(detail_of(got, f"로그인에 실패했습니다 (HTTP {status})"))

    raise Fail("시간 안에 승인되지 않았습니다 — 다시 login 하세요")


def _default_device_name() -> str:
    import socket

    host = socket.gethostname().split(".")[0]
    user = os.environ.get("USER") or os.environ.get("USERNAME") or ""
    return f"{user}@{host}" if user else host


def cmd_logout(args) -> int:
    if not CONFIG_PATH.exists():
        print("로그인돼 있지 않습니다")
        return 0
    CONFIG_PATH.unlink()
    print(f"이 기기의 자격을 지웠습니다 ({CONFIG_PATH})")
    # 지운다고 서버의 토큰이 없어지진 않는다 — 거기까지 하려면 웹에서 회수해야 한다.
    print("서버에 남은 토큰까지 없애려면 웹의 CLI 안내 페이지에서 '회수' 를 누르세요")
    return 0


def cmd_whoami(args) -> int:
    cfg = load_config()
    if not cfg.get("token"):
        print("로그인돼 있지 않습니다 — filesharer login")
        return 1
    server = server_of(args)
    status, spaces = request(server, "/api/spaces", token=cfg["token"])
    if status == 401:
        raise Fail("자격이 만료되거나 회수됐습니다 — filesharer login")
    print(f"  서버    {server}")
    print(f"  기기    {cfg.get('label', '')}")
    if cfg.get("expires_at"):
        print(f"  만료    {cfg['expires_at'][:10]}")
    if isinstance(spaces, list):
        print(f"  범위    {', '.join(s['name'] for s in spaces) or '(없음)'}")
    return 0


# ── 경로 풀기 ───────────────────────────────────────────────────────────


def spaces(server: str, token: str) -> list[dict]:
    status, body = request(server, "/api/spaces", token=token)
    if status == 401:
        raise Fail("자격이 만료되거나 회수됐습니다 — filesharer login")
    if status != 200 or not isinstance(body, list):
        raise Fail(detail_of(body, f"공간 목록을 받지 못했습니다 (HTTP {status})"))
    return body


def children(server: str, token: str, *, space_id: str, node_id: str | None) -> list[dict]:
    path = (
        f"/api/nodes/{node_id}/children" if node_id else f"/api/spaces/{space_id}/children"
    )
    status, body = request(server, path, token=token)
    if status != 200 or not isinstance(body, list):
        raise Fail(detail_of(body, f"목록을 받지 못했습니다 (HTTP {status})"))
    return body


def resolve(server: str, token: str, path: str) -> tuple[dict, dict | None]:
    """``내 공간/IDP/보고서.md`` → (공간, 노드 또는 None).

    경로를 생략하면 **범위 안에 공간이 하나일 때만** 그걸 쓴다. 둘 이상이면 어디를
    말하는지 묻는다 — 엉뚱한 공간에 올리는 것보다 한 번 더 묻는 쪽이 낫다.
    """
    parts = [p for p in (path or "").split("/") if p]
    available = spaces(server, token)
    if not available:
        raise Fail("접근할 수 있는 공간이 없습니다")

    if parts and any(s["name"] == parts[0] for s in available):
        space = next(s for s in available if s["name"] == parts[0])
        rest = parts[1:]
    elif len(available) == 1:
        space, rest = available[0], parts
    else:
        names = " · ".join(s["name"] for s in available)
        raise Fail(f"어느 공간인지 앞에 붙여주세요 — {names}")

    node: dict | None = None
    for depth, name in enumerate(rest):  # index(name) 을 쓰면 같은 이름이 두 번 나올 때 어긋난다
        here = children(server, token, space_id=space["id"], node_id=node["id"] if node else None)
        match = next((n for n in here if n["name"] == name), None)
        if match is None:
            where = "/".join([space["name"], *rest[:depth]])
            # **없다는 말만 하면 버그인지 오타인지 구분이 안 된다.** 거기 뭐가 있는지
            # 같이 보여주면 대개 그 줄에서 끝난다.
            lines = [
                f"'{where}' 안에 '{name}'{josa(name, '이', '가')} 없습니다",
                f"  여기 있는 것: {preview_names(here)}",
            ]
            # 첫 칸에서 틀렸고 쓸 수 있는 공간이 하나뿐이면, 다른 공간 이름을 적었을
            # 가능성이 크다 — 그 토큰으론 애초에 못 간다는 걸 말해준다.
            if depth == 0 and len(available) == 1:
                lines.append(
                    f"  이 자격은 '{available[0]['name']}'만 볼 수 있습니다 — "
                    "다른 공간을 쓰려면 filesharer login 으로 범위를 넓히세요"
                )
            raise Fail("\n".join(lines))
        node = match
    return space, node


# ── ls / put / get ──────────────────────────────────────────────────────


# 받침이 있는 것으로 읽히는 끝글자. 숫자는 읽은 소리(영·일·삼·육·칠·팔), 영문은
# 엘·엠·엔·알. 웹(lib/josa.ts)과 같은 규칙인데, '을/를'·'이/가' 는 ㄹ 예외가 없어 더 쉽다.
_BATCHIM_DIGITS = set("013678")
_BATCHIM_LETTERS = set("lmnr")


def has_batchim(word: str) -> bool:
    for ch in reversed(word or ""):
        if "가" <= ch <= "힣":
            return (ord(ch) - 0xAC00) % 28 != 0
        if ch.isdigit():
            return ch in _BATCHIM_DIGITS
        if ch.isalpha():
            return ch.lower() in _BATCHIM_LETTERS
    return False  # 읽을 글자가 없으면 받침 없는 쪽(짧은 조사)


def josa(word: str, with_batchim: str, without: str) -> str:
    """``josa(name, "을", "를")`` — 이름 뒤에 붙일 조사만 돌려준다.

    '(을)를' 로 피하면 틀리진 않지만 공문서 투다. 폴더·파일 이름은 사용자가 짓는데
    그 뒤에 조사를 박아두면 절반은 틀린 말이 된다.
    """
    return with_batchim if has_batchim(word) else without


def preview_names(rows: list[dict], limit: int = 6) -> str:
    """'여기 있는 것' 한 줄. 많으면 끊고 몇 개 더 있는지 말한다."""
    if not rows:
        return "(비어 있음)"
    names = [n["name"] for n in rows]
    shown = " · ".join(names[:limit])
    return shown if len(names) <= limit else f"{shown} … 외 {len(names) - limit}개"


def human(size: int) -> str:
    units = ("B", "KB", "MB", "GB", "TB")
    v = float(size)
    for unit in units:
        if v < 1024 or unit == units[-1]:
            return f"{v:.0f}{unit}" if unit == "B" else f"{v:.1f}{unit}"
        v /= 1024
    return f"{size}B"


def cmd_ls(args) -> int:
    server, token = server_of(args), token_of()
    if not args.path:
        found = spaces(server, token)
        for s in found:
            print(f"  📁  {s['name']}")
        return 0

    space, node = resolve(server, token, args.path)
    if node and node["type"] == "file":
        print(f"  📄  {node['name']}  {human(node['size'])}")
        return 0
    rows = children(server, token, space_id=space["id"], node_id=node["id"] if node else None)
    if not rows:
        print("  (비어 있음)")
    for n in rows:
        if n["type"] == "folder":
            print(f"  📁  {n['name']}")
        else:
            print(f"  📄  {n['name']}  {human(n['size'])}  {n['updated_at'][:10]}")
    return 0


def _multipart(field: str, filename: str, payload: bytes, mime: str) -> tuple[bytes, str]:
    boundary = "----filesharer" + secrets.token_hex(16)
    # 파일 이름은 한글일 수 있다. RFC 2231 로 넘기면 서버가 못 알아듣는 구현이 있어,
    # 널리 받아들여지는 UTF-8 그대로 싣는다(서버가 FastAPI/starlette 라 문제없다).
    head = (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="{field}"; filename="{filename}"\r\n'
        f"Content-Type: {mime}\r\n\r\n"
    ).encode()
    tail = f"\r\n--{boundary}--\r\n".encode()
    return head + payload + tail, f"multipart/form-data; boundary={boundary}"


def split_put_args(items: list[str], to: str | None) -> tuple[list[Path], str]:
    """``put a.txt b.txt '내 공간/IDP'`` 에서 파일들과 올릴 곳을 가른다.

    argparse 로는 못 가른다 — ``nargs="+"`` 가 위치 인자를 전부 먹어서 올릴 곳까지
    파일로 본다(실제로 "파일이 아닙니다: 내 공간" 이 났다).

    ``--to`` 가 있으면 그게 올릴 곳이고 나머지는 전부 파일이다. 없으면 scp 처럼
    **마지막 것을 올릴 곳으로** 본다 — 단, 그게 **내 디스크에 없는 이름일 때만**.
    있는 파일이면 올리려던 것이지 경로가 아니다. 애매하면 파일 쪽으로 읽는다.
    """
    if to is not None:
        return [Path(i) for i in items], to
    if len(items) >= 2 and not Path(items[-1]).exists():
        return [Path(i) for i in items[:-1]], items[-1]
    return [Path(i) for i in items], ""


def cmd_put(args) -> int:
    server, token = server_of(args), token_of()
    sources, dest_path = split_put_args(args.files, args.to)
    for src in sources:
        if not src.is_file():
            hint = " — 올릴 곳을 적으려면 --to 를 쓰세요" if not src.exists() else ""
            raise Fail(f"파일이 아닙니다: {src}{hint}")

    space, node = resolve(server, token, dest_path)
    if node and node["type"] != "folder":
        name = node["name"]
        raise Fail(f"'{name}'{josa(name, '은', '는')} 폴더가 아닙니다")
    dest = (
        f"/api/nodes/{node['id']}/files" if node else f"/api/spaces/{space['id']}/files"
    )
    where = "/".join([space["name"], *dest_path.split("/")[1:]]).rstrip("/")

    for src in sources:
        mime = mimetypes.guess_type(src.name)[0] or "application/octet-stream"
        body, ctype = _multipart("file", src.name, src.read_bytes(), mime)
        status, got = request(
            server, dest, method="POST", raw_body=body, content_type=ctype, token=token
        )
        if status != 201:
            raise Fail(detail_of(got, f"{src.name} 올리기에 실패했습니다 (HTTP {status})"))
        made = got[0] if isinstance(got, list) and got else got
        name = made.get("name", src.name) if isinstance(made, dict) else src.name
        note = f"  (같은 이름이 있어 '{name}' 로 올렸습니다)" if name != src.name else ""
        print(f"  ↑  {src.name} → {where}{note}")
    return 0


def cmd_get(args) -> int:
    server, token = server_of(args), token_of()
    space, node = resolve(server, token, args.path)
    if node is None:
        raise Fail("받을 대상을 경로에 적어주세요")
    if node["type"] != "file":
        name = node["name"]
        raise Fail(
            f"'{name}'{josa(name, '은', '는')} 폴더입니다 — 아직 폴더째 받기는 지원하지 않습니다"
        )

    out = Path(args.output) if args.output else Path(node["name"])
    if out.is_dir():
        out = out / node["name"]
    if out.exists() and not args.force:
        raise Fail(
            f"이미 있습니다: {out}\n"
            f"  다른 곳에 받으려면  -o 받을위치\n"
            f"  덮어쓰려면          --force"
        )

    status, body = request(server, f"/api/files/{node['id']}", token=token)
    if status != 200 or not isinstance(body, bytes):
        raise Fail(detail_of(body, f"받지 못했습니다 (HTTP {status})"))
    # 받다 만 파일이 제 이름으로 남으면 다음에 '있다' 고 착각한다 — 다 받고 나서 옮긴다
    tmp = out.with_name(out.name + f".part{secrets.token_hex(3)}")
    tmp.write_bytes(body)
    tmp.replace(out)
    print(f"  ↓  {node['name']} → {out}  ({human(len(body))})")
    return 0


# ── 진입점 ──────────────────────────────────────────────────────────────


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="filesharer", description="FileSharer 명령줄 클라이언트 — 브라우저 없이 파일 주고받기"
    )
    p.add_argument("--server", help="서버 주소 (기본: 로그인할 때 쓴 곳)")
    sub = p.add_subparsers(dest="cmd", required=True)

    lg = sub.add_parser("login", help="브라우저로 로그인한다")
    lg.add_argument("--name", help="이 기기의 이름 (승인 화면에 뜬다)")
    lg.add_argument("--no-browser", action="store_true", help="브라우저를 열지 않는다")
    lg.set_defaults(func=cmd_login)

    sub.add_parser("logout", help="이 기기의 자격을 지운다").set_defaults(func=cmd_logout)
    sub.add_parser("whoami", help="지금 누구로, 어디까지, 언제까지").set_defaults(func=cmd_whoami)

    ls = sub.add_parser("ls", help="둘러본다")
    ls.add_argument("path", nargs="?", default="", help="예: '내 공간/IDP'")
    ls.set_defaults(func=cmd_ls)

    put = sub.add_parser(
        "put",
        help="올린다",
        description="예: filesharer put 보고서.md '내 공간/IDP'   (또는 --to 로 명시)",
    )
    put.add_argument("files", nargs="+", help="올릴 파일 (마지막이 없는 이름이면 올릴 곳으로 본다)")
    put.add_argument("--to", help="올릴 곳 (예: '내 공간/IDP'). 적으면 위치 인자는 전부 파일")
    put.set_defaults(func=cmd_put)

    get = sub.add_parser("get", help="받는다")
    get.add_argument("path", help="예: '내 공간/IDP/보고서.md'")
    get.add_argument("-o", "--output", help="저장할 위치")
    get.add_argument("--force", action="store_true", help="같은 이름이 있어도 덮어쓴다")
    get.set_defaults(func=cmd_get)
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return args.func(args)
    except KeyboardInterrupt:
        print("\n취소했습니다", file=sys.stderr)
        return 130


if __name__ == "__main__":
    sys.exit(main())
