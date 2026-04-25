#!/usr/bin/env sh
set -e
mc alias set local "$MINIO_ENDPOINT" "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD"
mc mb --ignore-existing "local/$MINIO_BUCKET"
echo "bucket $MINIO_BUCKET ready"
