#!/usr/bin/env bash
#
# fs-upload.sh — FileSharer 서버(헤드리스) 업로드 CLI (curl 래퍼, 의존성: bash + curl)
#
# 브라우저/세션 없이 API 토큰(Bearer)으로 FileSharer에 파일을 밀어 넣는다.
# 토큰은 파일 화면의 "서버 업로드" 버튼 또는 /tokens 화면에서 발급한다.
# 서버에는 토큰 해시만 저장되며, 원문은 발급 직후 한 번만 표시된다.
#
# 사용법:
#   FS_BASE=https://file.rgrg.im FS_TOKEN=fsk_... \
#     ./fs-upload.sh --folder <FOLDER_ID> a.log b.log
#   ./fs-upload.sh --base https://file.rgrg.im --token fsk_... --space <SPACE_ID> report.csv
#
# 옵션:
#   --base URL        FileSharer 주소 (또는 환경변수 FS_BASE)
#   --token TOKEN     API 토큰   (또는 환경변수 FS_TOKEN — 환경변수 권장:
#                     --token 으로 넘기면 ps 목록에 노출될 수 있다)
#   --folder ID       업로드할 폴더 node id (/api/nodes/<ID>/files)
#   --space  ID       공간 루트에 업로드     (/api/spaces/<ID>/files)
#   --rel-path PATH   서버측 상대경로(중간 폴더 자동 생성). 파일이 하나일 때 유효.
#   -h, --help        도움말
#
# --folder 와 --space 중 정확히 하나를 지정한다. 토큰 범위 밖이면 서버가 403을 반환한다.
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
if [ -z "$FOLDER" ] && [ -z "$SPACE" ]; then err "--folder 또는 --space 중 하나가 필요합니다"; fi

BASE="${BASE%/}"
if [ -n "$FOLDER" ]; then
  URL="$BASE/api/nodes/$FOLDER/files"
else
  URL="$BASE/api/spaces/$SPACE/files"
fi

rc=0
for f in "${FILES[@]}"; do
  [ -f "$f" ] || { echo "건너뜀(파일 없음): $f" >&2; rc=1; continue; }
  args=(-fsS -X POST -H "Authorization: Bearer $TOKEN" -F "file=@$f")
  if [ -n "$REL_PATH" ]; then args+=(-F "rel_path=$REL_PATH"); fi
  echo "↥ $f → $URL"
  if curl "${args[@]}" "$URL"; then
    echo   # 서버가 준 JSON 뒤 줄바꿈
  else
    echo "업로드 실패: $f" >&2
    rc=1
  fi
done
exit "$rc"
