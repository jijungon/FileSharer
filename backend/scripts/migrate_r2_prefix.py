"""기존 R2 객체를 버킷 루트(프리픽스 없는 bare 키) → R2_PREFIX 아래로 옮기는 일회성 마이그레이션.

dev/prod가 한 버킷을 공유하게 프리픽스를 도입했을 때, 이미 루트에 쌓여 있던
객체를 해당 환경 프리픽스(dev/ 등) 밑으로 정리한다. DB의 storage_key는 bare uuid를
그대로 유지하므로 건드리지 않는다(R2 객체 키만 이동).

사용(backend 디렉터리에서, R2_PREFIX 설정 상태로):
    python -m scripts.migrate_r2_prefix           # dry-run(기본): 옮길 목록만 출력
    python -m scripts.migrate_r2_prefix --apply   # 실제 이동
"""

from __future__ import annotations

import sys


def migrate_root_to_prefix(client, bucket: str, prefix: str, *, apply: bool = False) -> dict:
    """버킷 루트의 bare 키 객체(키에 '/' 없음)를 prefix 아래로 이동한다.
    이미 '/'가 있는 키(다른 프리픽스 포함)는 건드리지 않는다. idempotent.
    반환: {"moved": [(src, dst), ...], "skipped": int}.
    """
    if not prefix:
        raise ValueError("prefix가 비어있음 — R2_PREFIX를 설정하세요")
    moved: list[tuple[str, str]] = []
    skipped = 0
    paginator = client.get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=bucket):
        for obj in page.get("Contents", []):
            key = obj["Key"]
            if "/" in key:  # 이미 프리픽스가 있는 키는 대상 아님
                skipped += 1
                continue
            dst = f"{prefix}{key}"
            if apply:
                client.copy_object(
                    Bucket=bucket, Key=dst, CopySource={"Bucket": bucket, "Key": key}
                )
                client.delete_object(Bucket=bucket, Key=key)
            moved.append((key, dst))
    return {"moved": moved, "skipped": skipped}


def _r2_client(settings):  # noqa: ANN001
    import boto3
    from botocore.config import Config as BotoConfig

    endpoint = settings.r2_endpoint or (
        f"https://{settings.r2_account_id}.r2.cloudflarestorage.com"
    )
    return boto3.client(
        "s3",
        endpoint_url=endpoint,
        aws_access_key_id=settings.r2_access_key_id,
        aws_secret_access_key=settings.r2_secret_access_key,
        region_name="auto",
        config=BotoConfig(signature_version="s3v4", retries={"max_attempts": 3}),
    )


def main(argv: list[str] | None = None) -> int:
    from app.config import get_settings

    argv = sys.argv[1:] if argv is None else argv
    apply = "--apply" in argv

    s = get_settings()
    if s.storage_backend != "r2":
        print(f"STORAGE_BACKEND={s.storage_backend} (r2 아님) — 할 일 없음")
        return 0
    if not s.r2_prefix:
        print("R2_PREFIX가 비어있음 — 이동할 대상 프리픽스가 없습니다")
        return 1

    client = _r2_client(s)
    result = migrate_root_to_prefix(client, s.r2_bucket, s.r2_prefix, apply=apply)
    tag = "이동함" if apply else "이동 예정(dry-run, 실제 이동하려면 --apply)"
    for src, dst in result["moved"]:
        print(f"  {src}  ->  {dst}")
    print(
        f"{tag}: {len(result['moved'])}개, 건너뜀(이미 프리픽스 있음): {result['skipped']}개 "
        f"[bucket={s.r2_bucket}, prefix={s.r2_prefix}]"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
