#!/bin/sh
# FileSharer 일일 백업 — filesharer-data 볼륨(blobs + SQLite)을 tar.gz 스냅샷으로.
# 사용: ./deploy/backup.sh [백업디렉토리]   (기본 ./backups, 최근 14개 보관)
# VM crontab 예: 0 4 * * * cd /opt/filesharer && ./deploy/backup.sh /opt/backups >> /var/log/filesharer-backup.log 2>&1
set -eu

BACKUP_DIR="${1:-./backups}"
STAMP="$(date +%Y%m%d-%H%M%S)"
KEEP=14

mkdir -p "$BACKUP_DIR"
docker run --rm \
  -v filesharer-data:/data:ro \
  -v "$(cd "$BACKUP_DIR" && pwd)":/backup \
  alpine:3.20 \
  tar czf "/backup/filesharer-$STAMP.tar.gz" -C /data .

# 보관 개수 초과분 삭제 (오래된 것부터)
ls -1t "$BACKUP_DIR"/filesharer-*.tar.gz 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r old; do
  rm -f "$old"
done

echo "ok: $BACKUP_DIR/filesharer-$STAMP.tar.gz"
