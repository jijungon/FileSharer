"""쌓인 백업 회차를 본다 — 읽기 전용(삭제·수정 없음).

"백업이 실제로 돌고 있는가"를 확인하는 용도. 복원은 여기서 하지 않는다(사람이 받아서 푼다).

사용: backend/.venv/bin/python backend/scripts/backup_list.py
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.config import get_settings  # noqa: E402
from app.services import backup  # noqa: E402


def main() -> None:
    settings = get_settings()
    store = backup.build_backup_store(settings)
    where = (
        f"R2 {settings.r2_bucket}/{settings.backup_prefix}"
        if settings.storage_backend == "r2"
        else Path(settings.data_dir) / "backups"
    )
    print(f"대상: {where}")
    print(
        f"보관 정책: 주간 {settings.backup_keep_weekly}개 · "
        f"월간 {settings.backup_keep_monthly}개\n"
    )

    rows = list(backup.list_runs(store))
    if not rows:
        print("아직 백업이 없습니다.")
        return

    print(f"{'종류':<8}{'회차':<12}{'만든 시각':<22}{'공간':>5}{'파일':>7}{'용량':>14}")
    print("-" * 70)
    for row in rows:
        m = row["manifest"]
        if m is None:
            print(f"{row['kind']:<8}{row['stamp']:<12}{'(미완성 — manifest 없음)'}")
            continue
        print(
            f"{row['kind']:<8}{row['stamp']:<12}{m['created_at'][:19]:<22}"
            f"{len(m['spaces']):>5}{m['total_files']:>7}{m['total_bytes']:>14,}"
        )


if __name__ == "__main__":
    main()
