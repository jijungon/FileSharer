#!/usr/bin/env python3
"""fs_upload.py — FileSharer 서버(헤드리스) 업로드 CLI (Python 표준 라이브러리만 사용).

브라우저/세션 없이 API 토큰(Bearer)으로 FileSharer에 파일을 밀어 넣는다. 외부 패키지
불필요(urllib). 토큰은 파일 화면의 "서버 업로드" 버튼(🔑 임시 토큰 발급)에서 발급한다.
서버에는 토큰 해시만 저장되고, 원문은 발급 직후 한 번만 표시된다.

사용 예(범위 토큰이면 --folder/--space 없이 그냥 파일만 나열):
    FS_BASE=https://file.rgrg.im FS_TOKEN=fsk_... python3 fs_upload.py a.log b.log
    # 명시 위치로:  --folder <FOLDER_ID>  또는  --space <SPACE_ID>

--folder/--space 를 둘 다 생략하면 /api/upload 로 올린다 — 목적지는 토큰 범위가 정한다.
(둘을 함께 쓸 수는 없다.) 토큰 범위 밖이면 서버가 403. 보안상 토큰은 --token 인자보다
환경변수 FS_TOKEN 사용을 권장한다(인자는 ps 목록에 노출될 수 있음).
"""

import argparse
import json
import mimetypes
import os
import sys
import urllib.error
import urllib.request
import uuid
from pathlib import Path


def _multipart(file_path: Path, rel_path: str | None) -> tuple[bytes, str]:
    """(본문 바이트, Content-Type) 반환 — multipart/form-data 수동 인코딩."""
    boundary = uuid.uuid4().hex
    mime = mimetypes.guess_type(file_path.name)[0] or "application/octet-stream"
    crlf = b"\r\n"
    parts: list[bytes] = []
    if rel_path:
        parts += [
            f"--{boundary}".encode(),
            b'Content-Disposition: form-data; name="rel_path"',
            b"",
            rel_path.encode(),
        ]
    disp = f'Content-Disposition: form-data; name="file"; filename="{file_path.name}"'
    parts += [
        f"--{boundary}".encode(),
        disp.encode(),
        f"Content-Type: {mime}".encode(),
        b"",
        file_path.read_bytes(),
        f"--{boundary}--".encode(),
        b"",
    ]
    return crlf.join(parts), f"multipart/form-data; boundary={boundary}"


def upload_one(base: str, url_path: str, token: str, file_path: Path, rel_path: str | None) -> dict:
    body, content_type = _multipart(file_path, rel_path)
    req = urllib.request.Request(
        f"{base}{url_path}",
        data=body,
        method="POST",
        headers={"Authorization": f"Bearer {token}", "Content-Type": content_type},
    )
    with urllib.request.urlopen(req) as resp:  # noqa: S310 (신뢰된 사내 호스트)
        return json.loads(resp.read().decode())


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="FileSharer 헤드리스 업로드 (API 토큰)",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument("--base", default=os.environ.get("FS_BASE", ""), help="FileSharer 주소 (또는 FS_BASE)")
    parser.add_argument("--token", default=os.environ.get("FS_TOKEN", ""), help="API 토큰 (또는 FS_TOKEN, 권장)")
    parser.add_argument("--folder", help="(선택) 명시 폴더 node id — 없으면 토큰 범위로")
    parser.add_argument("--space", help="(선택) 명시 공간 루트 space id — 없으면 토큰 범위로")
    parser.add_argument(
        "--dir", dest="dirs", action="append", default=[],
        help="폴더 통째로 — 안의 모든 파일을 구조 유지하며 업로드(여러 번 지정 가능)",
    )
    parser.add_argument("--rel-path", dest="rel_path", help="서버측 상대경로(중간 폴더 자동 생성)")
    parser.add_argument("files", nargs="*", help="올릴 파일 경로(들)")
    args = parser.parse_args(argv)

    if not args.base:
        parser.error("--base 또는 환경변수 FS_BASE 가 필요합니다")
    if not args.token:
        parser.error("--token 또는 환경변수 FS_TOKEN 이 필요합니다")
    if args.folder and args.space:
        parser.error("--folder 와 --space 는 함께 쓸 수 없습니다")
    if not args.files and not args.dirs:
        parser.error("올릴 파일이나 --dir 폴더를 지정하세요")
    if args.rel_path and (len(args.files) > 1 or args.dirs):
        parser.error("--rel-path 는 파일이 하나일 때만 쓸 수 있습니다(--dir와 함께 못 씀)")

    base = args.base.rstrip("/")
    if args.folder:
        url_path = f"/api/nodes/{args.folder}/files"
    elif args.space:
        url_path = f"/api/spaces/{args.space}/files"
    else:
        url_path = "/api/upload"  # 목적지는 토큰 범위가 정한다

    rc = 0
    # 업로드 대상 (경로, rel_path) 목록. --dir 는 폴더의 부모 기준 상대경로로 구조를 유지한다.
    targets: list[tuple[Path, str | None]] = [(Path(n), args.rel_path) for n in args.files]
    for d in args.dirs:
        dp = Path(d)
        if not dp.is_dir():
            print(f"건너뜀(폴더 없음): {d}", file=sys.stderr)
            rc = 1
            continue
        for f in sorted(p for p in dp.rglob("*") if p.is_file()):
            targets.append((f, str(f.relative_to(dp.parent))))

    for path, rel in targets:
        if not path.is_file():
            print(f"건너뜀(파일 없음): {path}", file=sys.stderr)
            rc = 1
            continue
        print(f"↥ {rel or path.name} → {base}{url_path}")
        try:
            node = upload_one(base, url_path, args.token, path, rel)
            print(f"  ok: {node.get('name')} ({node.get('size')}B) id={node.get('id')}")
        except urllib.error.HTTPError as exc:
            detail = ""
            try:
                detail = json.loads(exc.read().decode()).get("detail", "")
            except Exception:  # noqa: BLE001
                pass
            print(f"  실패 HTTP {exc.code}: {detail or exc.reason}", file=sys.stderr)
            rc = 1
        except urllib.error.URLError as exc:
            print(f"  실패(연결): {exc.reason}", file=sys.stderr)
            rc = 1
    return rc


if __name__ == "__main__":
    raise SystemExit(main())
