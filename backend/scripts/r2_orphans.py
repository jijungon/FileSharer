"""R2 dev/ 프리픽스의 고아 오브젝트를 찾는다 — 읽기 전용(기본). 삭제는 --delete 를 줘야만.

배경: e2e/로컬 테스트가 실제 R2로 업로드해 왔고 /api/test/reset 은 DB 행만 지우므로
블롭이 남는다. 지우기 전에 "무엇이 참조되고 있는지"를 로컬의 모든 SQLite DB에서 모아
대조한다. 참조가 하나라도 있으면 고아가 아니다(휴지통 항목도 복원 가능하므로 참조로 친다).

사용:
  읽기 전용 집계:  python backend/scripts/r2_orphans.py
  실제 삭제:       python backend/scripts/r2_orphans.py --delete --yes
"""

from __future__ import annotations

import argparse
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.config import get_settings  # noqa: E402

REPO = Path(__file__).resolve().parent.parent.parent


def human(n: float) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{n:,.1f} {unit}"
        n /= 1024.0
    return f"{n} B"


def find_dbs() -> list[Path]:
    """레포와 워크트리, 스크래치패드에서 찾을 수 있는 모든 SQLite DB."""
    out: list[Path] = []
    patterns = ["data/app.db", "backend/data/app.db"]
    for p in patterns:
        f = REPO / p
        if f.is_file():
            out.append(f)
    # 워크트리들
    wt = REPO / ".claude" / "worktrees"
    if wt.is_dir():
        for d in wt.iterdir():
            for p in patterns:
                f = d / p
                if f.is_file():
                    out.append(f)
    # 스크래치패드(있으면)
    for f in Path("/private/tmp").glob("claude-*/**/scratchpad/*.db"):
        out.append(f)
    return out


def referenced_keys(dbs: list[Path]) -> tuple[set[str], list[tuple[Path, int]]]:
    """모든 DB에서 storage_key 를 모은다(삭제된 것도 복원 가능하므로 포함)."""
    keys: set[str] = set()
    per_db: list[tuple[Path, int]] = []
    for db in dbs:
        try:
            con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
            rows = con.execute(
                "SELECT storage_key FROM nodes WHERE storage_key IS NOT NULL AND storage_key <> ''"
            ).fetchall()
            con.close()
        except Exception as e:  # noqa: BLE001
            print(f"  ! {db} 읽기 실패: {e}")
            continue
        got = {r[0] for r in rows}
        keys |= got
        per_db.append((db, len(got)))
    return keys, per_db


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--prefix", default=None, help="검사할 프리픽스(기본: 설정의 R2_PREFIX)")
    ap.add_argument("--delete", action="store_true", help="고아를 실제로 삭제")
    ap.add_argument("--yes", action="store_true", help="삭제 확인 생략")
    args = ap.parse_args()

    s = get_settings()
    if s.storage_backend != "r2":
        print(f"STORAGE_BACKEND={s.storage_backend} — R2가 아닙니다.")
        return
    prefix = args.prefix if args.prefix is not None else s.r2_prefix
    if not prefix:
        print("프리픽스가 비어 있습니다. 전체 버킷을 대상으로 하는 건 위험해 중단합니다.")
        return
    if prefix.startswith("prod"):
        print("prod 프리픽스는 이 스크립트로 다루지 않습니다. 중단.")
        return

    print("참조 중인 storage_key 수집…")
    dbs = find_dbs()
    keys, per_db = referenced_keys(dbs)
    for db, n in per_db:
        print(f"  {db}  →  {n}개")
    print(f"  합계(중복 제거): {len(keys)}개\n")

    import boto3
    from botocore.config import Config

    endpoint = s.r2_endpoint or f"https://{s.r2_account_id}.r2.cloudflarestorage.com"
    client = boto3.client(
        "s3",
        endpoint_url=endpoint,
        aws_access_key_id=s.r2_access_key_id,
        aws_secret_access_key=s.r2_secret_access_key,
        config=Config(signature_version="s3v4"),
        region_name="auto",
    )

    orphans: list[tuple[str, int]] = []
    kept = 0
    kept_size = 0
    paginator = client.get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=s.r2_bucket, Prefix=prefix):
        for obj in page.get("Contents", []) or []:
            key = obj["Key"]
            bare = key[len(prefix) :] if key.startswith(prefix) else key
            if bare in keys:
                kept += 1
                kept_size += obj["Size"]
            else:
                orphans.append((key, obj["Size"]))

    osize = sum(s_ for _, s_ in orphans)
    print("=" * 60)
    print(f"프리픽스 {prefix!r}")
    print(f"  참조됨(보존): {kept:,}개  {human(kept_size)}")
    print(f"  고아(삭제 후보): {len(orphans):,}개  {human(osize)}")
    print("=" * 60)
    for k, sz in orphans[:5]:
        print(f"  예시: {k}  {human(sz)}")

    if not args.delete:
        print("\n읽기 전용 모드입니다. 삭제하려면 --delete --yes 를 주세요.")
        return
    if not orphans:
        print("\n삭제할 고아가 없습니다.")
        return
    if not args.yes:
        print("\n--yes 가 없어 삭제하지 않았습니다.")
        return

    print(f"\n{len(orphans):,}개 삭제 시작…")
    deleted = 0
    batch: list[dict[str, str]] = []
    for k, _ in orphans:
        batch.append({"Key": k})
        if len(batch) == 1000:
            client.delete_objects(Bucket=s.r2_bucket, Delete={"Objects": batch})
            deleted += len(batch)
            print(f"  {deleted:,}/{len(orphans):,}")
            batch = []
    if batch:
        client.delete_objects(Bucket=s.r2_bucket, Delete={"Objects": batch})
        deleted += len(batch)
    print(f"삭제 완료: {deleted:,}개 ({human(osize)} 회수)")


if __name__ == "__main__":
    main()
