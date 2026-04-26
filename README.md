# Carve

On-prem, web-based annotation editor for computer-vision datasets — detection, segmentation, classification — with multi-user auth, custom YOLO auto-annotation, SAM 2 / SAM 3 interactive smart annotation, and full image + video object tracking. Exports are first-class YOLO and COCO with class remap and train/val/test split.

**v1.1** adds a SAM model selector (`sam2.1-tiny`, `sam2.1-small`, `sam2.1-base-plus`, `sam2.1-large`, `sam3`), bf16 autocast, optional `torch.compile`, idle GPU eviction, and full SAM 3 integration (text-prompted image segmentation and concept-based video tracking).

## Status

| Version | What it ships | Tag |
|---|---|---|
| v0.1.0 | Foundation (compose, auth scaffolding) | `v0.1.0-foundation` |
| v0.2.0 | Projects, classes, tasks | `v0.2.0-projects` |
| v0.3.0 | Asset ingestion, MinIO, thumbnails | `v0.3.0-assets` |
| v0.4.0 | Annotation canvas (PixiJS, manual tools) | `v0.4.0-canvas` |
| v0.5.0 | YOLO + SAM 2 inference, video tracking | `v0.5.0-inference` |
| v0.6.0 | YOLO/COCO import + export with class remap | `v0.6.0-import-export` |
| v0.7.0 | Per-task and per-project analytics | `v0.7.0-analytics` |
| v1.0.0 | TLS, first-run wizard, rate limits, polish | `v1.0.0` |
| v1.1.0 | SAM model selector, bf16, compile, eviction, SAM 3 | `v1.1.0` |
| v1.3.0 | SAM 3 click-prompt routing fix (Sam3TrackerModel + Sam3TrackerVideoModel) | (current branch) |

Tag history: <https://github.com/your-org/Carve/tags> (replace with your fork).

## Features

- **Tasks**: detection (boxes), segmentation (polygons + binary masks), classification — manual or YOLO-assisted. Compatible with YOLO11 and **YOLO26** (Jan 2026) detection / segmentation / classification weights out of the box; pose and OBB weights load but are v2-deferred in the editor UI.
- **Smart annotation**: SAM 2.1 click-to-mask (positive / negative points), SAM 3 text prompts ("person", "yellow truck"), browser-side WebGPU decoder fallback for sub-30 ms clicks.
- **Video tracking**: SAM 2 point-based propagation across frames, or SAM 3 concept-based tracking driven by a text query.
- **Export**: YOLO (det + seg) and COCO (det + seg) with per-class remap, train/val/test split, and skipped-asset reports.
- **Analytics**: per-task and per-project dashboards (asset counts, annotation throughput, class distribution).
- **Production polish**: TLS via Caddy + Let's Encrypt, first-run admin wizard, slowapi rate limits, scripted Postgres + MinIO backups, VitePress docs site at `/docs`.

## System requirements

- **OS**: Linux x86_64 (tested on Ubuntu 22.04+). macOS works for development but provides no GPU inference.
- **Docker**: 26+, Docker Compose v2.
- **GPU** (for SAM / YOLO inference): NVIDIA GPU with CUDA 12.6 driver and the [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html) installed. CPU-only deployments work for auth, projects, asset management, manual annotation, import/export, and analytics — only inference paths require a GPU.
- **VRAM** (per loaded model, with `SAM_BF16=1`):

| Model | Approx VRAM | Notes |
|---|---|---|
| `sam2.1-tiny` | ~3 GB | Fastest, smallest |
| `sam2.1-small` | ~4 GB | Lightweight production |
| `sam2.1-base-plus` | ~6 GB | Balanced |
| `sam2.1-large` | ~9 GB | Default; best SAM 2 quality |
| `sam3` | ~12 GB | Concept tracking + text prompts |
| YOLO (custom weights) | ~1–6 GB depending on the .pt file | Loaded **only when used**; LRU capacity 2 |

> The SAM and YOLO registries are independent and lazy — neither loads at startup, neither evicts the other. If you only use SAM, YOLO never claims VRAM, and vice versa. With both loaded, peak VRAM is roughly the sum (e.g., SAM 2.1 Large at bf16 ~9 GB + a 6 GB YOLO weight ≈ 15 GB; comfortable on 16 GB GPUs).

On a single RTX 4070 (16 GB): all SAM 2.1 sizes fit comfortably; SAM 3 fits with bf16 enabled (the default).

- **Disk**: ~12 GB image cache for the Docker build, plus your asset volume and Postgres data.

### Editor without inference models

Manual annotation (bounding box, polygon, mask brush, tag) requires no GPU and no model service. The model service is optional — the operator can deploy `api`, `web`, `postgres`, `redis`, `minio`, `caddy` without `model` and still get the full multi-user editor with import/export and analytics. SAM-assisted clicks and YOLO auto-annotate become unavailable; manual tools are unaffected.

## First-time setup

The steps below take you from a fresh clone to the **first-run admin wizard** in your browser. Each command can be copy-pasted as-is from the repo root.

### 1. Clone

```bash
git clone <repo-url> Carve
cd Carve
```

### 2. Copy and edit env

```bash
cp .env.example .env
sed -i "s|^JWT_SECRET=.*|JWT_SECRET=$(openssl rand -hex 32)|" .env
sed -i "s|^PASSWORD_PEPPER=.*|PASSWORD_PEPPER=$(openssl rand -hex 16)|" .env
```

Open `.env` in an editor and review the rest. At minimum, set `POSTGRES_PASSWORD` and `MINIO_ROOT_PASSWORD` to non-default values, and set `CARVE_DOMAIN` to your real hostname (or leave `localhost` for a local install).

Never commit `.env` — it is in `.gitignore`.

### 3. Choose your SAM model (optional)

Default is `sam2.1-large`. If your GPU has less than ~9 GB free VRAM, lower it:

```bash
# Edit .env: SAM_MODEL=sam2.1-tiny|sam2.1-small|sam2.1-base-plus|sam2.1-large|sam3
```

For `sam3` you must also accept the model license on Hugging Face and supply `HF_TOKEN`. See the [SAM model selection](#sam-model-selection) section below.

### 4. Build and start

```bash
docker compose up -d --build
```

The first build downloads PyTorch + SAM weights and takes a while (5–15 minutes on a typical connection). Subsequent runs are fast.

### 5. Verify it's running

```bash
docker compose ps
```

You should see all services as `healthy` after a minute or two:

```text
NAME             SERVICE    STATUS
carve-api-1        api        healthy
carve-caddy-1      caddy      running
carve-minio-1      minio      healthy
carve-model-1      model      healthy
carve-postgres-1   postgres   healthy
carve-redis-1      redis      healthy
carve-web-1        web        healthy
```

Quick smoke checks:

```bash
curl -fsS http://localhost/api/health           # → {"status":"ok"}
curl -fsS http://localhost/api/auth/bootstrap-status   # → {"users_exist":false} on a fresh DB
```

### 6. First-run admin wizard

Visit `https://<CARVE_DOMAIN>` (or `http://localhost` in dev). On a fresh database, the web app shows the **First-run admin wizard**: enter a username, email, and password. Submitting creates the bootstrap admin and locks public registration.

After that:

1. Log in as the admin you just created.
2. Click **New project**, define a class palette (index, name, color per class).
3. Click **New task** inside the project.
4. Drag-and-drop image or video assets into the task dropzone.
5. Open any asset to launch the annotation canvas.

Full UI walkthrough: <https://localhost/docs/getting-started>.

## .env reference

All variables live in `.env`. Defaults below are the values shipped in `.env.example`.

### Application secrets

| Variable | Default | Purpose |
|---|---|---|
| `JWT_SECRET` | placeholder | HMAC secret for JWTs. **Must** be at least 32 random hex chars. |
| `PASSWORD_PEPPER` | placeholder | Server-side pepper added to argon2 password hashes. |
| `JWT_ACCESS_TTL_MIN` | `15` | Access token lifetime in minutes. |
| `JWT_REFRESH_TTL_DAYS` | `14` | Refresh token lifetime in days. |
| `CORS_ORIGINS` | `http://localhost:5173,http://localhost` | Comma-separated CORS origins for the API. |

### TLS / domain

| Variable | Default | Purpose |
|---|---|---|
| `CARVE_DOMAIN` | `localhost` | Public domain. Caddy auto-issues a Let's Encrypt cert when set to a real DNS name. |
| `LETSENCRYPT_EMAIL` | empty | Email for Let's Encrypt account + expiry alerts. |

### Database

| Variable | Default | Purpose |
|---|---|---|
| `POSTGRES_USER` | `carve` | Postgres role used by the API. |
| `POSTGRES_PASSWORD` | placeholder | Postgres password. |
| `POSTGRES_DB` | `carve` | Database name. |
| `POSTGRES_HOST` | `postgres` | Hostname (resolved via Docker DNS). |
| `POSTGRES_PORT` | `5432` | Port. |

### Object storage (MinIO)

| Variable | Default | Purpose |
|---|---|---|
| `MINIO_ROOT_USER` | `carve` | MinIO admin user. |
| `MINIO_ROOT_PASSWORD` | placeholder | MinIO admin password. |
| `MINIO_ENDPOINT` | `http://minio:9000` | S3 endpoint used by the API and worker. |
| `MINIO_BUCKET` | `carve-assets` | Bucket name. Created automatically by `minio-init`. |

### Redis

| Variable | Default | Purpose |
|---|---|---|
| `REDIS_HOST` | `redis` | Hostname. |
| `REDIS_PORT` | `6379` | Port. |

### SAM model selection (v1.1)

| Variable | Default | Purpose |
|---|---|---|
| `SAM_MODEL` | `sam2.1-large` | One of `sam2.1-tiny`, `sam2.1-small`, `sam2.1-base-plus`, `sam2.1-large`, `sam3`. |
| `SAM_BF16` | `1` | bf16 autocast on Ampere+ GPUs. Set `0` to force FP32 (debugging only). |
| `SAM_COMPILE` | `0` | `1` enables `torch.compile` (~1.3–2× faster after a 30–60 s warmup). |
| `SAM_IDLE_TIMEOUT_S` | `900` | Seconds of inactivity before SAM is unloaded from VRAM. `0` disables eviction. |
| `HF_TOKEN` | empty | Hugging Face read token. **Required** for `SAM_MODEL=sam3`. |
| `SAM_VARIANT` | unset | Legacy Plan 08 env (`sam2`/`sam3`). Honored only when `SAM_MODEL` is unset. |

For deeper SAM tuning, see [`apps/docs/admin.md`](apps/docs/admin.md).

### Other

| Variable | Default | Purpose |
|---|---|---|
| `API_ENV` | `development` | Set to `production` in real deployments. |
| `MODEL_DEVICE` | `cuda:0` | Device string for the model service. |
| `MODEL_BASE_URL` | `http://model:8100` | Internal URL the API uses to reach the model service. |

## Service breakdown

The production `docker-compose.yml` runs the following services. Only Caddy publishes to the host on 80/443; everything else is internal-only. `docker-compose.override.yml` (dev) additionally exposes Postgres, Redis, MinIO, the API, the model service, and the web dev port for local debugging.

| Service | Image / Build | Role | Internal port | Host port (prod) |
|---|---|---|---|---|
| `caddy` | `caddy:2-alpine` | TLS-terminating reverse proxy. Routes `/api/*`, `/model/*`, `/docs/*`, fallback to `web`. | 80, 443 | 80, 443 |
| `web` | `apps/web` | React + Vite frontend served by nginx. | 80 | — |
| `api` | `apps/api` | FastAPI app (auth, projects, tasks, assets, exports, analytics). Runs Alembic on startup. | 8000 | — |
| `worker` | `apps/api` | RQ worker for thumbnails + video metadata. | — | — |
| `model` (optional) | `apps/model` | FastAPI inference service. Loads SAM 2.1 / SAM 3 / YOLO **lazily and independently** on demand (optional — required only for SAM and YOLO). No host port — security gate from Plan 05. | 8100 | — |
| `docs` | `apps/docs` | VitePress site mounted at `/docs`. | 80 | — |
| `postgres` | `postgres:16-alpine` | Primary database. | 5432 | — |
| `redis` | `redis:7-alpine` | Job queue, embedding cache, rate-limit storage. | 6379 | — |
| `minio` | `minio/minio:RELEASE.2025-02-07` | S3-compatible asset storage. Console on 9001. | 9000, 9001 | — |
| `minio-init` | `minio/mc` | One-shot bucket bootstrap. Exits 0 once the bucket exists. | — | — |

In dev (`docker-compose.override.yml`), Postgres → 5432, Redis → 6379, MinIO → 9000/9001, API → 8000, model → 8100, and Vite preview → 5173 are all published on the host.

## SAM model selection

This is the headline v1.1 feature. Switch SAM size or jump to SAM 3 by editing `.env` and restarting the model container.

| `SAM_MODEL` | Use for | VRAM (bf16) | Speed | Click prompts | Text prompts | Video |
|---|---|---|---|---|---|---|
| `sam2.1-tiny` | Fast iteration, low-VRAM hosts | ~3 GB | fastest | yes | no | yes (point-based) |
| `sam2.1-small` | Lightweight production | ~4 GB | fast | yes | no | yes (point-based) |
| `sam2.1-base-plus` | Balanced | ~6 GB | medium | yes | no | yes (point-based) |
| `sam2.1-large` (default) | Best SAM 2 quality | ~9 GB | slower | yes | no | yes (point-based) |
| `sam3` | Concept tracking, text prompts | ~12 GB | similar | yes | yes | yes (text-based) |

### Switching models

```bash
# In .env, set SAM_MODEL to one of the values above, then:
docker compose restart model
```

SAM models lazy-load on first use and unload after `SAM_IDLE_TIMEOUT_S` seconds of inactivity (default 900 = 15 min). YOLO weights are managed independently by an LRU registry (capacity 2 by default). The two are not coordinated: if VRAM is tight on your hardware, run only one model class at a time.

SAM and YOLO are loaded independently. Switching SAM models does not evict loaded YOLO weights, and uploading a new YOLO weight does not evict SAM. If your GPU is VRAM-constrained, set `SAM_IDLE_TIMEOUT_S` to a low value (e.g., 60) so SAM frees memory between uses, and rely on the YOLO LRU's eviction (capacity 2) to bound YOLO footprint.

### Optimization knobs

- `SAM_BF16=1` (default): roughly half the VRAM and ~2× the throughput vs FP32 on RTX 30/40, A100, H100. Set `0` only to debug numerics.
- `SAM_COMPILE=1` (default `0`): `torch.compile` for ~1.3–2× extra speedup. Adds 30–60 s on the first call, then warm.
- `SAM_IDLE_TIMEOUT_S=900` (default): auto-unload after this many idle seconds. Set `0` to keep loaded forever.
- `POST /sam/unload` on the model service: admin endpoint inside the docker network (not proxied through Caddy) that force-frees immediately. Body: `{"which": "image" | "tracker" | "all"}`, default `"all"`. The response lists what was actually unloaded.

### SAM 3 setup

1. Visit <https://huggingface.co/facebook/sam3> and accept the license.
2. Generate an HF access token with **read** scope.
3. In `.env`, set `SAM_MODEL=sam3` and `HF_TOKEN=hf_xxx`.
4. Rebuild + restart the model service:

   ```bash
   docker compose build model && docker compose up -d model
   ```

### SAM 3 prompts — full prompt matrix (v1.3.0 correction)

> **v1.3.0:** SAM 3 video tracking now correctly supports **point prompts**
> (positive/negative) via `Sam3TrackerVideoModel`. Previous releases routed
> only text-concept tracking to SAM 3 video and incorrectly claimed point
> prompts were not exposed by HF transformers. They are: the
> `Sam3TrackerVideoProcessor.add_inputs_to_inference_session(...)` API
> provides full point/box prompting at frames. See
> `apps/docs/admin.md` for the full prompt support matrix.

SAM 3 ships four transformers classes; v1.3.0 wires each to the right
prompt route:

- `Sam3Model` (image concept) — text + boxes (no points)
- `Sam3VideoModel` (video concept) — text only
- `Sam3TrackerModel` (image, drop-in SAM 2 replacement) — points + boxes + masks
- `Sam3TrackerVideoModel` (video, drop-in SAM 2 replacement) — points + boxes at frames

API behavior when SAM 3 is active:

- `/sam/encode` + `/sam/decode` (image clicks): wire-compatible with SAM 2. Click points (positive=1 / negative=0) flow through `Sam3TrackerModel`.
- `/sam/text-prompt` (text-prompted image segmentation): functional with SAM 3 via `Sam3Model`. With any non-`sam3` model, this endpoint returns `409 sam3_not_enabled`.
- `/sam/box-prompt` (v1.2.2; box-prompted image segmentation): SAM 3 only, via `Sam3Model`. Accepts `{image_b64, boxes, box_labels, text?}` where `box_labels` are 1 (positive) or 0 (negative). Returns `409 sam3_box_prompt_requires_sam3` for non-`sam3` models.
- `/sam-track/start` (video tracking): with SAM 3, accepts EITHER click points (forwarded to `Sam3TrackerVideoModel.add_inputs_to_inference_session`) OR a text concept (forwarded to `Sam3VideoModel.add_text_prompt`). Returns `422 sam3_track_requires_points_or_text` when neither is supplied. Example bodies:
  - Click: `{"video_url": "...", "points": [[210, 350]], "labels": [1]}`
  - Text:  `{"video_url": "...", "text": "person"}`

Full SAM 3 docs: [`apps/docs/admin.md`](apps/docs/admin.md#sam-3-toggle).

## Common operations

### Tail logs

```bash
docker compose logs -f api web model caddy
```

### Restart a service

```bash
docker compose restart <service>     # api | web | model | caddy | worker | ...
```

### Apply a Postgres migration

The API runs `alembic upgrade head` automatically on startup. To apply manually:

```bash
docker compose exec api alembic upgrade head
```

### Postgres shell

```bash
docker compose exec postgres psql -U carve carve
```

### MinIO console

In dev (with `docker-compose.override.yml`), open <http://localhost:9001> and log in with `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` from `.env`. In production the console is internal-only — port-forward via SSH if you need it.

### Switch SAM model on the fly

```bash
# Edit .env: SAM_MODEL=...
docker compose restart model
```

### Force-unload SAM (admin)

The endpoint is on the model service's internal network only. From the host:

```bash
docker compose exec model curl -fsS -X POST http://localhost:8100/sam/unload \
  -H 'Content-Type: application/json' -d '{"which":"all"}'
```

### Clear SAM image embedding cache (Redis)

```bash
docker compose exec redis redis-cli FLUSHDB
```

This also clears any in-flight RQ job state and rate-limit counters — only run when you genuinely want to reset Redis.

## Backups and restore

`scripts/backup.sh` dumps Postgres and mirrors MinIO into a timestamped directory. It sources `.env` from the working directory, so run it from the repo root.

### Run a backup

```bash
./scripts/backup.sh /var/backups/carve
# Produces:
#   /var/backups/carve/pg-20260425T030000Z.sql.gz
#   /var/backups/carve/minio-20260425T030000Z/...
```

### Recommended cron (daily at 03:00)

```text
0 3 * * * cd /opt/carve && /opt/carve/scripts/backup.sh /var/backups/carve >> /var/log/carve-backup.log 2>&1
```

### Restore Postgres

```bash
gunzip -c /var/backups/carve/pg-<TS>.sql.gz | docker compose exec -T postgres psql -U carve carve
```

### Restore MinIO

```bash
docker run --rm --network carve_default \
  -e MC_HOST_local="http://${MINIO_ROOT_USER}:${MINIO_ROOT_PASSWORD}@minio:9000" \
  -v /var/backups/carve/minio-<TS>:/in \
  minio/mc:latest \
  mirror /in local/carve-assets
```

## Troubleshooting

- **First-run wizard never appears**: check `docker compose logs api`. The wizard is gated on `GET /auth/bootstrap-status` returning `{"users_exist": false}` — it only does so on a truly empty DB.
- **SAM inference is slow**: confirm `SAM_BF16=1` (it is, by default, on supported GPUs). For longer sessions, set `SAM_COMPILE=1` to enable `torch.compile`; the first call takes 30–60 s, subsequent calls are 1.3–2× faster.
- **Out of VRAM**: switch to a smaller `SAM_MODEL` (`sam2.1-tiny` or `sam2.1-small`), lower `SAM_IDLE_TIMEOUT_S` so the model unloads sooner, or call `POST /sam/unload` to free immediately.
- **CSP blocks images in the browser**: Caddy's default CSP is strict. If MinIO presigned URLs target a non-Caddy host (e.g. raw `http://localhost:9000` in dev), extend `img-src` and `connect-src` in `infra/caddy/Caddyfile`.
- **`SAM_MODEL=sam3` errors `model not registered`**: HF token missing or license not accepted. See the [SAM 3 setup](#sam-3-setup) section and `apps/docs/admin.md`.
- **Rate-limited (429)**: defaults are 10/min on `/auth/login`, 5/min on `/auth/register`, 30/min on `/weights`, 100/min on `/assets`. The slowapi storage is in-memory, so it resets when the API container restarts. Wait a minute or restart the api service.
- **Video tracking returns `422 sam3_track_requires_text`**: when `SAM_MODEL=sam3`, `/sam-track/start` requires `text` instead of click points. Pass `{"video_url": "...", "text": "<concept>"}`.
- **Reset everything (DESTROYS DATA)**: `docker compose down -v` removes named volumes (Postgres, Redis, MinIO, Caddy). Only use this for dev resets.

## Local development without Docker

You can run any subset of the services natively. Postgres / Redis / MinIO still run via Docker (`docker compose up -d postgres redis minio minio-init`).

### API

```bash
cd apps/api && python -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
alembic upgrade head
uvicorn carve_api.main:app --reload --port 8000
```

### Model

```bash
cd apps/model && python -m venv .venv && source .venv/bin/activate
pip install -e ".[dev,gpu]"   # gpu extras: torch, ultralytics, opencv, ffmpeg
uvicorn carve_model.main:app --reload --port 8100
```

The `gpu` extras bring in `torch==2.7.1`, `torchvision==0.22.1`, `ultralytics==8.4.41`, `opencv-python-headless`, `pycocotools`, and `ffmpeg-python`. SAM weights download from Hugging Face on first inference call. To use a YOLO release newer than the pinned Ultralytics version supports (e.g., a future YOLO26), override the pin in `apps/model/pyproject.toml` and rebuild the model service — the loader is version-agnostic.

### Web

```bash
cd apps/web && npm install && npm run dev
```

The Vite dev server proxies `/api` → `http://localhost:8000`.

### Tests

```bash
cd apps/api   && pytest
cd apps/model && pytest
cd apps/web   && npm test
```

## Repository layout

| Path | What it is |
|---|---|
| `apps/api` | FastAPI app service (auth, projects, tasks, assets, exports, analytics). |
| `apps/model` | FastAPI inference service (SAM 2.1, SAM 3, YOLO). |
| `apps/web` | React 19 + Vite + TS + PixiJS frontend. |
| `apps/docs` | VitePress operator docs, mounted at `/docs`. |
| `infra/caddy` | Caddy reverse-proxy config (TLS, CSP, routing). |
| `infra/minio` | MinIO bucket bootstrap script. |
| `scripts` | Operational scripts (`backup.sh`). |
| `docs/superpowers/specs` | Design specs. |
| `docs/superpowers/plans` | Per-sprint implementation plans. |

## Why slowapi?

slowapi is a defensive control against brute-force login, signup spam, and DoS through expensive uploads. The limits (10/min login, 5/min register, 30/min weights, 100/min assets) are deliberately tight on auth and looser on data-plane endpoints. Storage is in-memory so limits reset on api container restart — that is acceptable because the values are conservative anyway. See `apps/docs/admin.md` for the full list.

## License and contributing

- License: TBD (no `LICENSE` file in the repo yet).
- Operator docs: [`apps/docs/admin.md`](apps/docs/admin.md), or the live VitePress site at `https://<CARVE_DOMAIN>/docs`.
- Design specs and per-sprint plans: `docs/superpowers/specs/` and `docs/superpowers/plans/`.
