"""CLI 원본을 **읽어서** 상수로 들고 있는다.

파일을 런타임에 읽지 않는 이유: 이미지 안에서 경로가 어긋나면 그때서야 500 이 난다.
임포트 시점에 한 번 읽어 두면 기동할 때 바로 터져서, 배포 전에 알 수 있다.
"""

from pathlib import Path

_PATH = Path(__file__).resolve().parent.parent / "cli" / "filesharer.py"

CLI_SOURCE: str = _PATH.read_text("utf-8")
