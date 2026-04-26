# VisualAutoAnnotator

On-prem, web-based annotation editor for computer-vision datasets — detection, segmentation, classification — with auto-annotation (custom YOLO weights), interactive smart annotation (SAM 2/3), and video object tracking.

> **Status:** in development. See [the design spec](docs/superpowers/specs/2026-04-25-visual-auto-annotator-design.md) and the [implementation plans](docs/superpowers/plans/) for the per-sprint breakdown.

## Quickstart (development)

Requirements: Docker 26+, Docker Compose v2, ~12 GB free disk for images. An NVIDIA GPU + NVIDIA Container Toolkit will be required from Plan 05 onward.

```bash
git clone <this repo>
cd VisualAutoAnnotator
cp .env.example .env
sed -i "s|^JWT_SECRET=.*|JWT_SECRET=$(openssl rand -hex 32)|" .env
sed -i "s|^PASSWORD_PEPPER=.*|PASSWORD_PEPPER=$(openssl rand -hex 16)|" .env

docker compose up -d --build
```

Once healthy:

- Web app: <http://localhost>
- API docs: <http://localhost/api/docs>
- MinIO console: <http://localhost:9001>

The first registered user becomes the admin.

## Repository layout

| Path | What it is |
|---|---|
| `apps/api`    | FastAPI app service |
| `apps/model`  | FastAPI inference service |
| `apps/web`    | React + Vite + TS frontend |
| `infra/caddy` | Caddy reverse-proxy config |
| `docs/superpowers/specs` | Design specs |
| `docs/superpowers/plans` | Implementation plans |

## Local development without Docker

```bash
# API
cd apps/api && python -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
alembic upgrade head
uvicorn vaa_api.main:app --reload --port 8000

# Model
cd apps/model && python -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
uvicorn vaa_model.main:app --reload --port 8100

# Web
cd apps/web && npm install && npm run dev
```

The web dev server proxies `/api` → `http://localhost:8000`.

## Tests

```bash
cd apps/api && pytest
cd apps/model && pytest
cd apps/web && npm test
```

## Architecture

Three Docker services on one machine: a FastAPI **app service** (Postgres + Redis + MinIO + REST/WS), a FastAPI **model service** pinned to the GPU (SAM, YOLO, encode/decode/predict endpoints), and a Vite-built React **web service** behind Caddy. The browser SAM decoder runs in WebGPU so click-to-mask is < 30 ms after the encoder runs once on the server.

## Backups & restore

The repo includes `scripts/backup.sh` which dumps Postgres and mirrors MinIO into a timestamped directory.

### Run a backup

```bash
./scripts/backup.sh /var/backups/vaa
# Produces:
#   /var/backups/vaa/pg-20260425T030000Z.sql.gz
#   /var/backups/vaa/minio-20260425T030000Z/...
```

The script sources `.env` from the working directory, so run it from the repo root.

### Recommended schedule

```cron
0 3 * * * cd /opt/vaa && /opt/vaa/scripts/backup.sh /var/backups/vaa
```

### Restore Postgres

```bash
gunzip -c /var/backups/vaa/pg-<TS>.sql.gz | docker compose exec -T postgres psql -U vaa vaa
```

### Restore MinIO

```bash
docker run --rm --network vaa_default \
  -e MC_HOST_local="http://${MINIO_ROOT_USER}:${MINIO_ROOT_PASSWORD}@minio:9000" \
  -v /var/backups/vaa/minio-<TS>:/in \
  minio/mc:latest \
  mirror /in local/vaa-assets
```

## License

TBD.
