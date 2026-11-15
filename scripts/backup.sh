#!/usr/bin/env bash
set -euo pipefail
: "${BACKUP_AGE_RECIPIENT:?Set an age public recipient}"
: "${BACKUP_DIR:?Set a backup directory}"
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
umask 077
mkdir -p -- "$BACKUP_DIR"
BACKUP_DIR=$(cd -- "$BACKUP_DIR" && pwd)
# Serialize cron/manual runs, including pruning.
exec 9>"$BACKUP_DIR/.backup.lock"
flock -n 9
backup_tmp=$(mktemp "$BACKUP_DIR/.r9k-XXXXXXXX")
trap 'rm -f -- "$backup_tmp"' EXIT
backup_name="$BACKUP_DIR/r9k-$(date -u +%Y%m%dT%H%M%S)-$$.sql.gz.age"
docker compose -f compose.yaml -f compose.prod.yaml exec -T db pg_dump -U r9k -d r9k --no-owner --no-acl | gzip | age -r "$BACKUP_AGE_RECIPIENT" > "$backup_tmp"
mv -- "$backup_tmp" "$backup_name"
mapfile -d '' backups < <(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'r9k-*.sql.gz.age' -printf '%f\0' | sort -zr)
for ((i=14; i<${#backups[@]}; i++)); do rm -- "$BACKUP_DIR/${backups[i]}"; done
printf 'Saved %s\n' "$backup_name"
