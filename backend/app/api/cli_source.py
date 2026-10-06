"""CLI 원본을 **읽어서** 상수로 들고 있는다.

파일을 런타임에 읽지 않는 이유: 이미지 안에서 경로가 어긋나면 그때서야 500 이 난다.
임포트 시점에 한 번 읽어 두면 기동할 때 바로 터져서, 배포 전에 알 수 있다.

버전은 **원본 소스의 해시**다. 앱 버전(v1.0.x)을 쓰면 CLI 와 무관한 백엔드 배포마다
"새 버전이 있습니다" 가 떠서, 몇 번 겪으면 아무도 안 읽는 알림이 된다. 소스가 실제로
바뀔 때만 달라져야 한다. 서버 주소를 박아 넣기 **전**의 원본을 해시하므로, 어느
서버에서 받아도 같은 CLI 면 같은 버전이다.
"""

import hashlib
from pathlib import Path

_PATH = Path(__file__).resolve().parent.parent / "cli" / "filesharer.py"

CLI_SOURCE: str = _PATH.read_text("utf-8")
CLI_VERSION: str = hashlib.sha256(CLI_SOURCE.encode("utf-8")).hexdigest()[:12]
