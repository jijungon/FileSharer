"""DB에는 있는데 저장소에 **본체가 없는** 파일을 찾는다 — 읽기 전용(아무것도 안 지운다).

r2_orphans.py 의 반대다.

  · r2_orphans.py — 참조 없는 오브젝트. 공간만 축내고 사용자는 모른다.
  · 이 스크립트    — 알맹이 없는 기록. **사용자가 열면 실패한다.** 이쪽이 더 나쁘다.

어쩌다 생기나: 완전삭제가 blob 을 먼저 지우고 DB 행을 나중에 지우던 시절, 그 사이에
실패하면 DB만 롤백돼 '본체 없는 기록'이 남았다(고침: purge 는 커밋이 끝난 뒤에 blob 을
지운다 — services/trash.py). 그 밖에도 저장소 장애나 사람이 버킷을 직접 건드렸을 때
생길 수 있으니 점검 수단을 남겨둔다.

사용:
  backend/.venv/bin/python backend/scripts/missing_blobs.py
  backend/.venv/bin/python backend/scripts/missing_blobs.py --trash-only

컨테이너 안에서:
  docker compose exec app python scripts/missing_blobs.py

종료 코드: 없으면 0, 하나라도 있으면 1 (점검에 물려 쓸 수 있게).
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sqlalchemy import select  # noqa: E402

from app.config import get_settings  # noqa: E402
from app.db import build_engine, make_sessionmaker  # noqa: E402
from app.models import Node, Space  # noqa: E402
from app.services.permissions import space_display_name  # noqa: E402
from app.services.storage import build_storage  # noqa: E402


def human(n: float) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{n:,.1f} {unit}"
        n /= 1024.0
    return f"{n} B"


def node_path(db, node: Node) -> str:
    """공간 이름부터 이 노드까지의 읽기 좋은 경로."""
    parts = [node.name]
    cur, hops = node.parent_id, 0
    while cur and hops < 100:
        parent = db.get(Node, cur)
        if parent is None:
            break
        parts.append(parent.name)
        cur, hops = parent.parent_id, hops + 1
    space = db.get(Space, node.space_id)
    head = space_display_name(db, space) if space else "(알 수 없는 공간)"
    return "/".join([head, *reversed(parts)])


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--trash-only", action="store_true", help="휴지통 항목만 검사")
    args = ap.parse_args()

    settings = get_settings()
    storage = build_storage(settings)
    SessionLocal = make_sessionmaker(build_engine(settings.database_url))

    with SessionLocal() as db:
        q = select(Node).where(Node.type == "file", Node.storage_key != "")
        if args.trash_only:
            q = q.where(Node.deleted_at.is_not(None))
        files = list(db.scalars(q))

        missing = [n for n in files if not storage.exists(n.storage_key)]

        scope = "휴지통 항목" if args.trash_only else "전체 파일"
        print(f"검사 대상({scope}): {len(files)}개")
        if not missing:
            print("본체가 없는 파일: 없음 ✓")
            return 0

        print(f"\n본체가 없는 파일: {len(missing)}개 — 열면 실패한다\n")
        for n in missing:
            where = "휴지통" if n.deleted_at else "사용중"
            print(f"  [{where}] {node_path(db, n)}")
            print(f"           크기 {human(n.size)} · key={n.storage_key}")
        print(
            "\n지우지 않았다. 사용중인 것은 다시 올려야 하고, 휴지통 것은 완전삭제하면 된다."
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
