#!/usr/bin/env bash
# Carve — restore a Postgres logical backup into a FRESH database, then
# (optionally) promote it to the live database name.
#
# This never blind-restores over the live DB. It loads the dump into a
# throwaway database first so you can inspect/verify it, and only swaps it
# in when you explicitly pass --promote. Run from the repo root on the host.
#
# Usage:
#   infra/backup/restore.sh backups/daily/carve-YYYYMMDD-HHMMSS.sql.gz
#   infra/backup/restore.sh <dump.sql.gz> --promote     # also swap it live
#
set -euo pipefail

DUMP="${1:-}"
PROMOTE="${2:-}"
if [ -z "$DUMP" ] || [ ! -f "$DUMP" ]; then
  echo "usage: $0 <path/to/carve-*.sql.gz> [--promote]" >&2
  exit 1
fi

# Pull DB creds from .env (same as the stack).
ENV_FILE="${ENV_FILE:-.env}"
PGUSER="$(grep -E '^POSTGRES_USER=' "$ENV_FILE" | cut -d= -f2-)"
PGDB="$(grep -E '^POSTGRES_DB=' "$ENV_FILE" | cut -d= -f2-)"
RESTORE_DB="${RESTORE_DB:-${PGDB}_restore}"

psql() { docker compose exec -T postgres psql -U "$PGUSER" "$@"; }

echo ">> Creating fresh database '$RESTORE_DB' (dropping any prior copy)..."
psql -d postgres -c "DROP DATABASE IF EXISTS \"$RESTORE_DB\";"
psql -d postgres -c "CREATE DATABASE \"$RESTORE_DB\" OWNER \"$PGUSER\";"

echo ">> Loading $DUMP into '$RESTORE_DB'..."
gunzip -c "$DUMP" | docker compose exec -T postgres psql -q -U "$PGUSER" -d "$RESTORE_DB"

echo ">> Row counts in '$RESTORE_DB':"
psql -d "$RESTORE_DB" -c "SELECT
  (SELECT count(*) FROM annotations) AS annotations,
  (SELECT count(*) FROM classes)     AS classes,
  (SELECT count(*) FROM tasks)       AS tasks,
  (SELECT count(*) FROM projects)    AS projects;"

if [ "$PROMOTE" != "--promote" ]; then
  echo
  echo ">> Restore verified into '$RESTORE_DB' (live DB '$PGDB' untouched)."
  echo ">> To make it live: stop the app, then re-run with --promote, or manually:"
  echo "     docker compose stop api worker web"
  echo "     psql: ALTER DATABASE \"$PGDB\" RENAME TO \"${PGDB}_old\"; ALTER DATABASE \"$RESTORE_DB\" RENAME TO \"$PGDB\";"
  echo "     docker compose up -d"
  exit 0
fi

echo ">> --promote: swapping '$RESTORE_DB' in as '$PGDB'."
echo ">> Stopping app services that hold DB connections..."
docker compose stop api worker web
# Terminate any lingering backends so RENAME can take the lock.
psql -d postgres -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname IN ('$PGDB','$RESTORE_DB') AND pid <> pg_backend_pid();" >/dev/null || true
psql -d postgres -c "ALTER DATABASE \"$PGDB\" RENAME TO \"${PGDB}_old_$(date -u +%Y%m%d%H%M%S)\";"
psql -d postgres -c "ALTER DATABASE \"$RESTORE_DB\" RENAME TO \"$PGDB\";"
echo ">> Bringing the stack back up..."
docker compose up -d
echo ">> Done. Old database preserved as ${PGDB}_old_* — drop it once you've confirmed the restore."
