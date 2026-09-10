#!/bin/sh
# 백업 복원: ./deploy/restore.sh <백업파일.tar.gz>  (컨테이너 중지 상태에서 실행)
set -eu
[ $# -eq 1 ] || { echo "usage: $0 <backup.tar.gz>" >&2; exit 2; }
FILE="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
docker run --rm -v filesharer-data:/data -v "$FILE":/backup.tar.gz:ro alpine:3.20 \
  sh -c "rm -rf /data/* && tar xzf /backup.tar.gz -C /data"
echo "ok: restored from $1"
