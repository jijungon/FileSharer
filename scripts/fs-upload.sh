#!/usr/bin/env bash
#
# fs-upload.sh — FileSharer 서버(헤드리스) 업로드 CLI (curl 래퍼, 의존성: bash + curl)
#
# 브라우저/세션 없이 API 토큰(Bearer)으로 FileSharer에 파일을 밀어 넣는다.
# 토큰은 파일 화면의 "서버 업로드" 버튼(🔑 임시 토큰 발급)에서 발급한다.
# 서버에는 토큰 해시만 저장되며, 원문은 발급 직후 한 번만 표시된다.
#
# 사용법(범위 토큰이면 --folder/--space 없이 그냥 파일만 나열):
#   FS_BASE=https://file.rgrg.im FS_TOKEN=fsk_... ./fs-upload.sh a.log b.log report.csv
#   # 명시 위치로 올리려면:  --folder <FOLDER_ID>  또는  --space <SPACE_ID>
#
# 옵션:
#   --base URL        FileSharer 주소 (또는 환경변수 FS_BASE)
#   --token TOKEN     API 토큰   (또는 환경변수 FS_TOKEN — 환경변수 권장:
#                     --token 으로 넘기면 ps 목록에 노출될 수 있다)
#   --folder ID       (선택) 명시 폴더 node id (/api/nodes/<ID>/files)
#   --space  ID       (선택) 명시 공간 루트     (/api/spaces/<ID>/files)
#                     둘 다 없으면 /api/upload 로 — 목적지는 토큰 범위가 정한다.
#   --rel-path PATH   서버측 상대경로(중간 폴더 자동 생성). 파일이 하나일 때만.
#   -h, --help        도움말
#
# --folder 와 --space 는 함께 못 쓴다. 둘 다 생략하면 토큰이 목적지를 정한다(/api/upload).
# 토큰 범위 밖이면 서버가 403. 여러 파일은 한 요청에 함께 전송된다.
set -euo pipefail

BASE="${FS_BASE:-}"
TOKEN="${FS_TOKEN:-}"
FOLDER=""
SPACE=""
REL_PATH=""
FILES=()

usage() { sed -n '2,/^set -euo/p' "$0" | sed 's/^# \{0,1\}//; s/^#$//' | sed '$d'; exit "${1:-0}"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --base) BASE="$2"; shift 2 ;;
    --token) TOKEN="$2"; shift 2 ;;
    --folder) FOLDER="$2"; shift 2 ;;
    --space) SPACE="$2"; shift 2 ;;
    --rel-path) REL_PATH="$2"; shift 2 ;;
    -h|--help) usage 0 ;;
    --) shift; while [ $# -gt 0 ]; do FILES+=("$1"); shift; done ;;
    -*) echo "알 수 없는 옵션: $1" >&2; usage 1 ;;
    *) FILES+=("$1"); shift ;;
  esac
done

err() { echo "오류: $*" >&2; exit 1; }

[ -n "$BASE" ] || err "--base 또는 FS_BASE 가 필요합니다"
[ -n "$TOKEN" ] || err "--token 또는 FS_TOKEN 이 필요합니다"
[ ${#FILES[@]} -gt 0 ] || err "올릴 파일을 하나 이상 지정하세요"
if [ -n "$FOLDER" ] && [ -n "$SPACE" ]; then err "--folder 와 --space 는 함께 쓸 수 없습니다"; fi
if [ -n "$REL_PATH" ] && [ ${#FILES[@]} -gt 1 ]; then
  err "--rel-path 는 파일이 하나일 때만 쓸 수 있습니다"
fi

BASE="${BASE%/}"
if [ -n "$FOLDER" ]; then
  URL="$BASE/api/nodes/$FOLDER/files"
elif [ -n "$SPACE" ]; then
  URL="$BASE/api/spaces/$SPACE/files"
else
  URL="$BASE/api/upload"   # 목적지는 토큰 범위가 정한다
fi

# 존재하는 파일을 모아 '한 요청'에 전송(-F file=@ 를 여러 번).
args=(-fsS -X POST -H "Authorization: Bearer $TOKEN")
sent=0
missing=0
for f in "${FILES[@]}"; do
  if [ -f "$f" ]; then
    args+=(-F "file=@$f"); sent=$((sent + 1))
  else
    echo "건너뜀(파일 없음): $f" >&2; missing=1
  fi
done
[ "$sent" -gt 0 ] || err "올릴 수 있는 파일이 없습니다"
if [ -n "$REL_PATH" ]; then args+=(-F "rel_path=$REL_PATH"); fi

echo "↥ ${sent}개 파일 → $URL"
if curl "${args[@]}" "$URL"; then
  echo   # 서버가 준 JSON 뒤 줄바꿈
  exit "$missing"
else
  echo "업로드 실패" >&2
  exit 1
fi
