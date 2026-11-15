#!/usr/bin/env bash
set -euo pipefail
: "${BACKUP_AGE_IDENTITY:?Set path to the age private identity file}"
backup_file=$(realpath -- "${1:?Usage: restore.sh backup.sql.gz.age}")
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
printf 'This replaces the R9K database. Type RESTORE to continue: '
read -r confirmation
[[ "$confirmation" == RESTORE ]] || exit 1
umask 077
restore_tmp=$(mktemp)
trap 'rm -f -- "$restore_tmp"' EXIT
# Verify/decrypt fully before changing the database.
age -d -i "$BACKUP_AGE_IDENTITY" "$backup_file" | gzip -d > "$restore_tmp"
docker compose -f compose.yaml -f compose.prod.yaml stop bot
docker compose -f compose.yaml -f compose.prod.yaml exec -T db dropdb -U r9k --if-exists r9k
docker compose -f compose.yaml -f compose.prod.yaml exec -T db createdb -U r9k r9k
docker compose -f compose.yaml -f compose.prod.yaml exec -T db psql -X -v ON_ERROR_STOP=1 -U r9k -d r9k < "$restore_tmp"
docker compose -f compose.yaml -f compose.prod.yaml start bot
