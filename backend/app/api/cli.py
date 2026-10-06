"""CLI 배포 — 서버가 자기 클라이언트를 내준다.

별도 배포 채널(패키지 저장소·릴리스 페이지)을 두지 않는 이유는 **버전이 어긋나지
않게** 하기 위해서다. 서버가 바뀌면 그 서버가 내주는 CLI 도 같이 바뀐다.

주소도 서버가 박아 넣는다. 받는 쪽이 ``--server`` 를 외울 일이 없다.
"""

from fastapi import APIRouter, Request
from fastapi.responses import PlainTextResponse

from ..config import get_settings
from .cli_source import CLI_SOURCE, CLI_VERSION

router = APIRouter(prefix="/cli", tags=["cli"])

# **대입문 한 줄씩만** 바꾼다. 예전엔 자리표시자를 전부 치환했는데, CLI 안의
# '아직 안 채워졌나' 비교문까지 같이 바뀌어 주소를 찾고도 멈추는 사본이 나갔다.
_ASSIGN_SERVER = 'DEFAULT_SERVER = "__FILESHARER_SERVER__"'
_ASSIGN_VERSION = 'CLI_VERSION = "__FILESHARER_CLI_VERSION__"'

INSTALL_SH = """#!/bin/sh
# FileSharer CLI 설치. 받아서 실행 권한만 준다 — 그 이상 하지 않는다.
set -eu

SERVER="{server}"
DEST="${{FILESHARER_BIN:-$HOME/.local/bin}}"
TARGET="$DEST/filesharer"

command -v python3 >/dev/null 2>&1 || {{
  echo "python3 가 필요합니다. 설치한 뒤 다시 시도하세요." >&2
  exit 1
}}

mkdir -p "$DEST"
# 받다 만 파일이 실행 권한을 달고 남지 않게, 다 받은 뒤에 옮긴다.
TMP="$TARGET.part$$"
if command -v curl >/dev/null 2>&1; then
  curl -fsSL "$SERVER/cli/filesharer" -o "$TMP"
else
  wget -qO "$TMP" "$SERVER/cli/filesharer"
fi
chmod 755 "$TMP"
mv "$TMP" "$TARGET"

echo "설치했습니다: $TARGET"
case ":$PATH:" in
  *":$DEST:"*) echo "이제 'filesharer login' 을 치면 됩니다." ;;
  *) echo ""
     echo "$DEST 가 PATH 에 없습니다. 셸 설정에 아래 줄을 더하세요:"
     echo "    export PATH=\\"$DEST:$PATH\\""
     echo ""
     echo "지금 바로 쓰려면: $TARGET login" ;;
esac
"""


def _server(request: Request) -> str:
    settings = get_settings()
    # 공유 링크와 같은 규칙(shares.py 참고) — 설정이 비어 있으면 요청이 온 주소를 쓴다.
    configured = (settings.frontend_url or settings.base_url).rstrip("/")
    return configured or str(request.base_url).rstrip("/")


@router.get("/install.sh", response_class=PlainTextResponse)
def install_sh(request: Request) -> PlainTextResponse:
    body = INSTALL_SH.format(server=_server(request))
    return PlainTextResponse(body, media_type="text/x-shellscript; charset=utf-8")


@router.get("/filesharer", response_class=PlainTextResponse)
def cli_source(request: Request) -> PlainTextResponse:
    """CLI 본체. 주소를 박아 넣어 내준다."""
    server = _server(request)
    body = CLI_SOURCE.replace(_ASSIGN_SERVER, f'DEFAULT_SERVER = "{server}"', 1)
    body = body.replace(_ASSIGN_VERSION, f'CLI_VERSION = "{CLI_VERSION}"', 1)
    return PlainTextResponse(body, media_type="text/x-python; charset=utf-8")


@router.get("/version")
def version() -> dict:
    """지금 서버가 내주는 CLI 의 버전. CLI 가 '내가 낡았나' 를 묻는 곳이다.

    본문을 통째로 받아 비교하면 매번 20KB 를 끌어와야 한다. 여기는 몇 바이트다.
    """
    return {"version": CLI_VERSION}
