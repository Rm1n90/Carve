#!/usr/bin/env bash
set -euo pipefail
TS=$(date -u +%Y%m%dT%H%M%SZ)
OUT="${1:-./backups}"
mkdir -p "$OUT"

source .env

echo "==> postgres dump"
docker compose exec -T postgres pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB" \
  | gzip > "$OUT/pg-$TS.sql.gz"

echo "==> minio mirror"
docker run --rm --network vaa_default \
  -e MC_HOST_local="http://${MINIO_ROOT_USER}:${MINIO_ROOT_PASSWORD}@minio:9000" \
  -v "$OUT:/out" \
  minio/mc:latest \
  mirror "local/${MINIO_BUCKET}" "/out/minio-$TS"

echo "==> done; backups at $OUT (timestamp $TS)"
