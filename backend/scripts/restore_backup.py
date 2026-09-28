"""백업 한 회차를 **격리된 폴더로** 복원한다 — 운영은 건드리지 않는다.

복원해본 적 없는 백업은 백업이 아니다. 이 스크립트는 "정말 되돌아오는가"를 실제로 해보는
절차이자, 사고가 났을 때 그대로 쓰는 도구다. 자세한 사용법은 `deploy/RESTORE.md`.

무엇을 하나
  1. R2(또는 로컬)의 백업 회차를 **읽기만** 해서 내려받는다.
  2. manifest 의 sha256 과 대조해 **무결성을 확인**한다.
  3. `app.db.gz` 를 풀어 복원 DB를 만든다.
  4. 공간 tar 를 풀면서, 각 파일을 **원래 storage_key 이름으로** blobs/ 에 놓는다.
     (tar 에는 사람이 읽는 경로가, DB 에는 그 경로가 어느 키인지가 들어 있다. 둘을 맞춘다.)
  5. 그 폴더를 DATA_DIR 로 앱을 띄우면 **그대로 살아난다.**

쓰지 않는 것: 운영 DB·운영 블롭. 이 스크립트는 어디에도 쓰지 않는다(읽기 + 지정한 폴더).

사용:
  backend/.venv/bin/python backend/scripts/restore_backup.py \\
      --kind weekly --stamp 2026-W40 --into /tmp/restore-test
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.config import get_settings  # noqa: E402
from app.services import backup as backup_svc  # noqa: E402
from app.services.backup import node_paths, place_blobs  # noqa: E402

CHUNK = 1024 * 1024


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        while chunk := fh.read(CHUNK):
            digest.update(chunk)
    return digest.hexdigest()


def fetch(store, keys: list[str], out: Path) -> None:
    """백업 객체를 내려받는다(읽기 전용)."""
    for key in keys:
        dest = out / key.split("/", 2)[-1]  # weekly/2026-W40/ 접두사 제거
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(store.read_bytes(key))
        print(f"  받음  {dest.relative_to(out)}  ({dest.stat().st_size:,} bytes)")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--kind", choices=list(backup_svc.KINDS), default=backup_svc.WEEKLY)
    ap.add_argument("--stamp", required=True, help="회차 이름 (예: 2026-W40 / 2026-09)")
    ap.add_argument("--into", required=True, help="복원할 폴더(비어 있어야 한다)")
    args = ap.parse_args()

    base = f"{args.kind}/{args.stamp}"
    into = Path(args.into)
    if into.exists() and any(into.iterdir()):
        print(f"중단: {into} 가 비어 있지 않습니다. 새 폴더를 쓰세요.")
        raise SystemExit(1)
    download = into / "download"
    download.mkdir(parents=True, exist_ok=True)

    settings = get_settings()
    store = backup_svc.build_backup_store(settings)

    print(f"회차: {base}")
    manifest_key = f"{base}/manifest.json"
    if not store.exists(manifest_key):
        print("중단: manifest.json 이 없습니다(완결되지 않은 회차).")
        raise SystemExit(1)
    manifest = json.loads(store.read_bytes(manifest_key))
    (download / "manifest.json").write_bytes(json.dumps(manifest, ensure_ascii=False).encode())
    print(f"만든 시각: {manifest['created_at'][:19]}Z · 공간 {len(manifest['spaces'])}개\n")

    keys = [item["key"] for item in manifest["spaces"]]
    if manifest.get("db"):
        keys.append(manifest["db"]["key"])
    print("내려받는 중(읽기 전용)")
    fetch(store, keys, download)

    print("\n무결성 확인(manifest 의 sha256과 대조)")
    checked = [*manifest["spaces"], *([manifest["db"]] if manifest.get("db") else [])]
    for item in checked:
        local = download / item["key"].split("/", 2)[-1]
        actual = sha256_file(local)
        ok = actual == item["sha256"]
        print(f"  {'OK  ' if ok else '불일치'} {local.name}")
        if not ok:
            print("중단: 백업이 손상됐습니다.")
            raise SystemExit(1)

    if not manifest.get("db"):
        print("\nDB 스냅샷이 없는 회차입니다 — 파일만 복원됩니다.")
        return

    print("\nDB 스냅샷 푸는 중")
    db_path = into / "app.db"
    with gzip.open(download / "app.db.gz", "rb") as src, db_path.open("wb") as out:
        shutil.copyfileobj(src, out, CHUNK)
    print(f"  {db_path} ({db_path.stat().st_size:,} bytes)")

    print("\n파일 본체를 원래 키로 배치")
    table = node_paths(db_path)
    tars = sorted((download / "spaces").glob("*.tar.gz"))
    placed, missing = place_blobs(tars, table, into / "blobs")
    print(f"  {placed}개 배치 · DB에 없는 tar 항목 {len(missing)}개")
    for name in missing[:5]:
        print(f"    (건너뜀) {name}")

    absent = [key for key, _ in table.values() if not (into / "blobs" / key).is_file()]
    print(f"  DB가 가리키는데 tar 에 없던 파일: {len(absent)}개")

    print(f"""
복원 끝. 이 폴더로 앱을 띄우면 그대로 살아납니다:

  DATABASE_URL="sqlite:///{db_path}" \\
  DATA_DIR="{into}" \\
  STORAGE_BACKEND=local \\
  SECRET_KEY=<아무 값> APP_ENV=dev \\
  backend/.venv/bin/uvicorn app.main:app --app-dir backend --port 8600
""")


if __name__ == "__main__":
    main()
