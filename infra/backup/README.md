# Carve database backups

Automated logical backups of the Carve **Postgres** database — this is
where all annotation data lives: annotations and their bbox/polygon
geometry, classes, tasks, projects, users, the audit log, and asset/frame
*metadata*. It deliberately does **not** back up image/video bytes, which
live in MinIO (the `minio_data` volume), not in Postgres.

A full dump is ~19 MB compressed.

## How it runs

The `db-backup` service in `docker-compose.yml` runs `infra/backup/pg_backup.sh`
inside a `postgres:16-alpine` container (matching the DB's major version).
It waits for Postgres, takes one dump on startup, then dumps once a day at
`BACKUP_HOUR:00` UTC, writing to the host `./backups` folder with
grandfather-father-son rotation:

| Tier    | When            | Kept (default) | Location            |
|---------|-----------------|----------------|---------------------|
| daily   | every day       | `KEEP_DAILY=14`   | `backups/daily/`    |
| weekly  | Sundays         | `KEEP_WEEKLY=8`   | `backups/weekly/`   |
| monthly | 1st of month    | `KEEP_MONTHLY=12` | `backups/monthly/`  |

Tune via env vars in `.env` (all optional): `BACKUP_HOUR`, `KEEP_DAILY`,
`KEEP_WEEKLY`, `KEEP_MONTHLY`, `BACKUP_ON_START`.

## Operating it

```bash
docker compose up -d db-backup      # start / apply config changes
docker compose logs -f db-backup    # watch backups happen
ls -lh backups/daily                # see the dumps
```

Trigger an immediate ad-hoc backup without waiting for the schedule:

```bash
docker compose exec db-backup sh -c '. /pg_backup.sh 2>/dev/null; do_backup' \
  2>/dev/null || docker compose restart db-backup   # restart re-dumps on start
```

## Restoring

Use the helper, which loads into a throwaway DB first and leaves the live
one untouched until you explicitly promote:

```bash
# verify a dump restores cleanly (into <db>_restore, prints row counts)
infra/backup/restore.sh backups/daily/carve-YYYYMMDD-HHMMSS.sql.gz

# after verifying, swap it in as the live DB (stops app, renames, restarts)
infra/backup/restore.sh backups/daily/carve-YYYYMMDD-HHMMSS.sql.gz --promote
```

The previous live database is preserved as `carve_old_<timestamp>` after a
promote — drop it once you've confirmed the restore is good.

## ⚠️ These backups live on the same disk as the database

Local dumps protect against the common failure — an accidental delete or
an app bug wiping rows (exactly the class-delete incident). They do **not**
protect against loss of the disk/host itself. For real durability, copy
`backups/` off-box on a schedule (e.g. `rclone`/`aws s3 sync`/`rsync` to
another machine or object store). That step needs credentials and is left
to the operator.
