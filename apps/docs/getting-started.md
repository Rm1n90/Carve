# Getting started

## Prerequisites

- Docker 26+ and Docker Compose v2
- A domain name pointing to your host (for TLS via Caddy)
- GPU optional — inference paths (YOLO auto-annotate, SAM encoding) need an NVIDIA GPU + NVIDIA Container Toolkit; all other paths run on CPU

## 1. Clone and configure

```bash
git clone <repo-url>
cd Carve
cp .env.example .env
```

Edit `.env` and set at minimum:

| Variable | Purpose |
|---|---|
| `CARVE_DOMAIN` | Your domain, e.g. `annotate.example.com` |
| `JWT_SECRET` | Random hex string — `openssl rand -hex 32` |
| `PASSWORD_PEPPER` | Random hex string — `openssl rand -hex 16` |
| `POSTGRES_PASSWORD` | Postgres password |
| `MINIO_ROOT_PASSWORD` | MinIO root password |

## 2. Start the stack

```bash
docker compose up -d --build
```

Wait for all services to become healthy: `api`, `web`, `postgres`, `minio`, `redis`. Check with:

```bash
docker compose ps
```

## 3. First-run admin wizard

Visit `https://<your-domain>`. The first visit shows the **First-run admin wizard** — fill in a username, email, and password to create the bootstrap admin account. Public registration is locked after this step.

## 4. Create a project and task

1. Log in as admin and click **New project**.
2. Define your class palette: each class needs an index, a name, and a color.
3. Click **New task** inside the project and give it a name.
4. Upload image or video assets via the drag-and-drop dropzone.

## 5. Annotate

Open any asset from the task grid to launch the annotation canvas. See [Annotation tools](./tools) for details on each tool.
