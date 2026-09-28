"""R2 버킷을 프리픽스별로 집계한다 — 읽기 전용(삭제·수정 없음).

e2e/로컬 테스트가 실제 R2로 업로드해 왔고, /api/test/reset 은 DB 행만 지우고
블롭은 남기므로 고아 오브젝트가 쌓일 수 있다. 지우기 전에 "얼마나 있는지"부터 본다.

사용: backend/.venv/bin/python backend/scripts/r2_inventory.py [--sample N]
"""

from __future__ import annotations

import argparse
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.config import get_settings  # noqa: E402


def human(n: int) -> str:
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if n < 1024 or unit == "TB":
            return f"{n:,.1f} {unit}" if unit != "B" else f"{n:,} B"
        n /= 1024.0
    return f"{n} B"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--sample", type=int, default=3, help="프리픽스별로 보여줄 키 샘플 수")
    args = ap.parse_args()

    s = get_settings()
    if s.storage_backend != "r2":
        print(f"STORAGE_BACKEND={s.storage_backend} — R2가 아니라 집계할 것이 없습니다.")
        return

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

    # 최상위 프리픽스(첫 '/' 앞)별 집계. 프리픽스 없는 키는 "(없음)" 으로 묶는다.
    counts: dict[str, int] = defaultdict(int)
    sizes: dict[str, int] = defaultdict(int)
    samples: dict[str, list[str]] = defaultdict(list)
    total = 0
    total_size = 0

    paginator = client.get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=s.r2_bucket):
        for obj in page.get("Contents", []) or []:
            key = obj["Key"]
            size = obj["Size"]
            top = key.split("/", 1)[0] + "/" if "/" in key else "(프리픽스 없음)"
            counts[top] += 1
            sizes[top] += size
            if len(samples[top]) < args.sample:
                samples[top].append(key)
            total += 1
            total_size += size

    print(f"버킷: {s.r2_bucket}   (설정된 R2_PREFIX = {s.r2_prefix!r})")
    print("=" * 66)
    print(f"{'프리픽스':<24}{'개수':>10}{'용량':>16}")
    print("-" * 66)
    for top in sorted(counts, key=lambda k: -sizes[k]):
        print(f"{top:<24}{counts[top]:>10,}{human(sizes[top]):>16}")
    print("-" * 66)
    print(f"{'합계':<24}{total:>10,}{human(total_size):>16}")
    print("=" * 66)
    for top in sorted(counts, key=lambda k: -sizes[k]):
        print(f"\n[{top}] 샘플 키:")
        for k in samples[top]:
            print(f"  {k}")


if __name__ == "__main__":
    main()
