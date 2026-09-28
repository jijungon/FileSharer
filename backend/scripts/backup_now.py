"""백업을 지금 한 회차 만든다(수동 실행·점검용).

정기 실행은 앱이 스스로 한다(prod에서 1시간마다 '이번 회차가 있는지' 확인).
이 스크립트는 **처음 붙일 때 한 번 돌려보거나**, 사고 직전 상태를 급히 떠둘 때 쓴다.

사용:
  backend/.venv/bin/python backend/scripts/backup_now.py --kind weekly
  backend/.venv/bin/python backend/scripts/backup_now.py --kind monthly --force
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.config import get_settings  # noqa: E402
from app.db import build_engine, make_sessionmaker  # noqa: E402
from app.services import backup  # noqa: E402
from app.services.storage import build_storage  # noqa: E402


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--kind", choices=list(backup.KINDS), default=backup.WEEKLY)
    ap.add_argument("--force", action="store_true", help="이번 회차가 이미 있어도 다시 만든다")
    args = ap.parse_args()

    settings = get_settings()
    store = backup.build_backup_store(settings)
    engine = build_engine(settings.database_url)
    SessionLocal = make_sessionmaker(engine)

    where = (
        f"R2 {settings.r2_bucket}/{settings.backup_prefix}"
        if settings.storage_backend == "r2"
        else Path(settings.data_dir) / "backups"
    )
    print(f"대상: {where}")

    with SessionLocal() as db:
        manifest = backup.run_backup(
            db, build_storage(settings), store, args.kind, settings=settings, force=args.force
        )

    if manifest is None:
        print(f"이번 {args.kind} 회차는 이미 있습니다(--force 로 다시 만들 수 있습니다).")
        return

    print(f"\n{args.kind} {manifest['stamp']} 완료")
    for item in manifest["spaces"]:
        print(f"  {item['space']:<20} 파일 {item['files']:>4}개  {item['bytes']:>12,} bytes")
    if manifest["db"]:
        print(f"  {'DB 스냅샷':<20} {'':>9}  {manifest['db']['bytes']:>12,} bytes")


if __name__ == "__main__":
    main()
