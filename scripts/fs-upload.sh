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
#   FS_BASE=... FS_TOKEN=fsk_... ./fs-upload.sh --dir ./mydir   # 폴더 통째로(구조 유지)
#   # 명시 위치로 올리려면:  --folder <FOLDER_ID>  또는  --space <SPACE_ID>
#
# 옵션:
#   --base URL        FileSharer 주소 (또는 환경변수 FS_BASE)
#   --token TOKEN     API 토큰   (또는 환경변수 FS_TOKEN — 환경변수 권장:
#                     --token 으로 넘기면 ps 목록에 노출될 수 있다)
#   --folder ID       (선택) 명시 폴더 node id (/api/nodes/<ID>/files)
#   --space  ID       (선택) 명시 공간 루트     (/api/spaces/<ID>/files)
#                     둘 다 없으면 /api/upload 로 — 목적지는 토큰 범위가 정한다.
#   --dir DIR         폴더 통째로 — 안의 모든 파일을 구조 유지하며 전송(여러 번 지정 가능).
#   --rel-path PATH   서버측 상대경로(중간 폴더 자동 생성). 파일 하나일 때만(--dir와 못 씀).
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
DIRS=()

usage() { sed -n '2,/^set -euo/p' "$0" | sed 's/^# \{0,1\}//; s/^#$//' | sed '$d'; exit "${1:-0}"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --base) BASE="$2"; shift 2 ;;
    --token) TOKEN="$2"; shift 2 ;;
    --folder) FOLDER="$2"; shift 2 ;;
    --space) SPACE="$2"; shift 2 ;;
    --dir) DIRS+=("$2"); shift 2 ;;
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
[ $(( ${#FILES[@]} + ${#DIRS[@]} )) -gt 0 ] || err "올릴 파일이나 --dir 폴더를 지정하세요"
if [ -n "$FOLDER" ] && [ -n "$SPACE" ]; then err "--folder 와 --space 는 함께 쓸 수 없습니다"; fi
if [ -n "$REL_PATH" ] && { [ ${#FILES[@]} -gt 1 ] || [ ${#DIRS[@]} -gt 0 ]; }; then
  err "--rel-path 는 파일이 하나일 때만 쓸 수 있습니다(--dir와 함께 못 씀)"
fi

BASE="${BASE%/}"
if [ -n "$FOLDER" ]; then
  URL="$BASE/api/nodes/$FOLDER/files"
elif [ -n "$SPACE" ]; then
  URL="$BASE/api/spaces/$SPACE/files"
else
  URL="$BASE/api/upload"   # 목적지는 토큰 범위가 정한다
fi

rc=0

# 1) 개별 파일: 존재하는 것을 모아 '한 요청'에 전송(-F file=@ 를 여러 번).
if [ ${#FILES[@]} -gt 0 ]; then
  args=(-fsS -X POST -H "Authorization: Bearer $TOKEN")
  sent=0
  for f in "${FILES[@]}"; do
    if [ -f "$f" ]; then
      args+=(-F "file=@$f"); sent=$((sent + 1))
    else
      echo "건너뜀(파일 없음): $f" >&2; rc=1
    fi
  done
  if [ "$sent" -gt 0 ]; then
    [ -n "$REL_PATH" ] && args+=(-F "rel_path=$REL_PATH")
    echo "↥ ${sent}개 파일 → $URL"
    if curl "${args[@]}" "$URL"; then echo; else echo "업로드 실패" >&2; rc=1; fi
  fi
fi

# 2) 폴더: 안의 '모든 파일'을 구조 유지하며 하나씩 전송(rel_path로 하위 폴더 재생성).
if [ ${#DIRS[@]} -gt 0 ]; then
  for d in "${DIRS[@]}"; do
    [ -d "$d" ] || { echo "건너뜀(폴더 없음): $d" >&2; rc=1; continue; }
    parent=$(dirname "$d"); base=$(basename "$d"); n=0
    while IFS= read -r rel; do
      echo "↥ $rel → $URL"
      if curl -fsS -X POST -H "Authorization: Bearer $TOKEN" \
           -F "file=@$parent/$rel" -F "rel_path=$rel" "$URL"; then
        echo; n=$((n + 1))
      else
        echo "실패: $rel" >&2; rc=1
      fi
    done < <(cd "$parent" && find "$base" -type f)
    echo "  ($d → ${n}개 전송)"
  done
fi

exit "$rc"
