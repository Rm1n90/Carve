# Carve — Postgres logical backup sidecar.
#
# Runs inside a `postgres:16-alpine` container (same image as the DB, so
# pg_dump matches the server major version exactly) and writes compressed
# logical dumps of the Carve database to a host-mounted /backups folder on
# a daily schedule with grandfather-father-son (daily/weekly/monthly)
# rotation.
#
# What this captures: EVERYTHING in the Postgres database — annotations
# and their bbox/polygon geometry (JSONB), classes, tasks, projects,
# users, audit log, asset/frame *metadata* (incl. MinIO object keys). It
# does NOT capture the image/video bytes themselves: those live in MinIO,
# not Postgres, and are intentionally excluded. A dump is ~19 MB.
#
# Restore (into a FRESH database, then swap — never blind-restore over a
# live DB):
#   gunzip -c /backups/daily/carve-YYYYMMDD-HHMMSS.sql.gz \
#     | docker compose exec -T postgres psql -U <user> -d <fresh_db>
# See infra/backup/README.md for the full, safe restore procedure.
#
# POSIX sh (busybox). No `set -e`: this is a long-lived daemon, so a
# transient dump failure must NOT kill the loop — it logs and retries on
# the next cycle. `set -u` still guards against unset-variable typos.
set -u

BACKUP_DIR="${BACKUP_DIR:-/backups}"
PGHOST="${POSTGRES_HOST:-postgres}"
PGPORT="${POSTGRES_PORT:-5432}"
PGUSER="${POSTGRES_USER:?POSTGRES_USER is required}"
PGDATABASE="${POSTGRES_DB:?POSTGRES_DB is required}"
PGPASSWORD="${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required}"
export PGPASSWORD

# Daily run hour (00-23), evaluated in the container's clock (UTC).
BACKUP_HOUR="${BACKUP_HOUR:-02}"
# How many dumps to retain in each tier.
KEEP_DAILY="${KEEP_DAILY:-14}"
KEEP_WEEKLY="${KEEP_WEEKLY:-8}"
KEEP_MONTHLY="${KEEP_MONTHLY:-12}"
# Take one dump immediately on container start (validates config + gives
# instant coverage). Set to 0 to wait for the first scheduled slot.
BACKUP_ON_START="${BACKUP_ON_START:-1}"

log() { echo "[db-backup $(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"; }

# Values a superadmin saved in Carve (Settings -> Configuration) take
# precedence over the environment. Read again before every check, so a
# change applies without restarting this container; a value cleared there
# goes back to the environment's. If the database cannot be asked, the
# values in force stay as they are.
ENV_BACKUP_HOUR="$BACKUP_HOUR"; ENV_KEEP_DAILY="$KEEP_DAILY"
ENV_KEEP_WEEKLY="$KEEP_WEEKLY"; ENV_KEEP_MONTHLY="$KEEP_MONTHLY"
_applied=""
load_settings() {
  _rows=$(psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" -At -F '=' -c \
    "SELECT key, value FROM app_settings WHERE NOT encrypted AND key IN \
     ('BACKUP_HOUR','KEEP_DAILY','KEEP_WEEKLY','KEEP_MONTHLY')" 2>/dev/null) || return 0
  BACKUP_HOUR="$ENV_BACKUP_HOUR"; KEEP_DAILY="$ENV_KEEP_DAILY"
  KEEP_WEEKLY="$ENV_KEEP_WEEKLY"; KEEP_MONTHLY="$ENV_KEEP_MONTHLY"
  for _r in $_rows; do
    _k="${_r%%=*}"; _v="${_r#*=}"
    case "$_v" in ''|*[!0-9]*) continue ;; esac
    case "$_k" in
      BACKUP_HOUR) BACKUP_HOUR=$(printf '%02d' "$_v") ;;
      KEEP_DAILY) KEEP_DAILY="$_v" ;;
      KEEP_WEEKLY) KEEP_WEEKLY="$_v" ;;
      KEEP_MONTHLY) KEEP_MONTHLY="$_v" ;;
    esac
  done
  _now="daily@${BACKUP_HOUR}:00Z keep(d/w/m)=${KEEP_DAILY}/${KEEP_WEEKLY}/${KEEP_MONTHLY}"
  if [ "$_now" != "$_applied" ]; then
    [ -n "$_applied" ] && log "settings changed: schedule=$_now"
    _applied="$_now"
  fi
}

# A superadmin pressed "Back up now" in Carve (Settings -> Configuration).
# The request is taken off before the dump, so one that fails is not
# retried every 30 s; the page shows it as gone either way.
backup_requested() {
  _req=$(psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" -qAt -c \
    "DELETE FROM app_settings WHERE key = 'BACKUP_REQUESTED_AT' RETURNING value" \
    2>/dev/null) || return 1
  [ -n "$_req" ]
}

mkdir -p "$BACKUP_DIR/daily" "$BACKUP_DIR/weekly" "$BACKUP_DIR/monthly"

# Keep only the newest $2 *.sql.gz files in directory $1; delete the rest.
prune() {
  _dir="$1"; _keep="$2"
  ls -1t "$_dir"/*.sql.gz 2>/dev/null | tail -n +$((_keep + 1)) | while IFS= read -r _f; do
    rm -f "$_f" && log "pruned $(basename "$_f")"
  done
}

do_backup() {
  _ts="$(date -u +%Y%m%d-%H%M%S)"
  _partial="$BACKUP_DIR/daily/.carve-$_ts.sql.gz.partial"
  _out="$BACKUP_DIR/daily/carve-$_ts.sql.gz"
  log "dumping db=$PGDATABASE host=$PGHOST -> daily/carve-$_ts.sql.gz"
  # --no-owner/--no-privileges keep the dump restorable into a fresh DB
  # owned by any role. Write to a .partial name first and atomically
  # rename on success so a crash mid-dump never leaves a truncated file
  # that looks like a valid backup.
  if pg_dump -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" \
       --no-owner --no-privileges 2>/tmp/pg_dump.err | gzip -c > "$_partial"; then
    mv "$_partial" "$_out"
    _sz=$(wc -c < "$_out")
    log "ok $(awk "BEGIN{printf \"%.1f MB\", $_sz/1048576}") daily/carve-$_ts.sql.gz"
  else
    rm -f "$_partial"
    log "ERROR: pg_dump failed: $(tr '\n' ' ' < /tmp/pg_dump.err)"
    return 1
  fi

  # GFS promotion: Sunday -> weekly, 1st of month -> monthly.
  if [ "$(date -u +%u)" = "7" ]; then
    cp "$_out" "$BACKUP_DIR/weekly/" && log "promoted to weekly"
  fi
  if [ "$(date -u +%d)" = "01" ]; then
    cp "$_out" "$BACKUP_DIR/monthly/" && log "promoted to monthly"
  fi

  prune "$BACKUP_DIR/daily" "$KEEP_DAILY"
  prune "$BACKUP_DIR/weekly" "$KEEP_WEEKLY"
  prune "$BACKUP_DIR/monthly" "$KEEP_MONTHLY"
  return 0
}

# Wait for the database to accept connections before the first dump.
until pg_isready -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" >/dev/null 2>&1; do
  log "waiting for postgres to be ready..."
  sleep 3
done

load_settings
log "starting: schedule=daily@${BACKUP_HOUR}:00Z keep(d/w/m)=${KEEP_DAILY}/${KEEP_WEEKLY}/${KEEP_MONTHLY} dir=$BACKUP_DIR"

if [ "$BACKUP_ON_START" = "1" ]; then
  do_backup || log "startup backup failed; will retry on schedule"
fi

# Poll every 30s and fire once when the wall clock hits BACKUP_HOUR:00.
# `last_day` de-dupes so a single day never produces two scheduled dumps.
last_day=""
while true; do
  load_settings
  if backup_requested; then
    log "backup requested in Carve"
    do_backup || log "requested backup failed"
  fi
  _h="$(date -u +%H)"; _m="$(date -u +%M)"; _d="$(date -u +%Y%m%d)"
  if [ "$_h" = "$BACKUP_HOUR" ] && [ "$_m" = "00" ] && [ "$_d" != "$last_day" ]; then
    last_day="$_d"
    do_backup || log "scheduled backup failed; will retry next cycle"
  fi
  sleep 30
done
