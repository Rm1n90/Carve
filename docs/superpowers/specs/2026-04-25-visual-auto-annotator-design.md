# VisualAutoAnnotator — Design Spec

**Status:** Draft for user review
**Owner:** Armin
**Date:** 2026-04-25
**Doc type:** Brainstorm-stage design (precedes implementation plan)

---

## 1. Overview

VisualAutoAnnotator is an on-prem, web-based annotation editor for computer-vision datasets. It supports **detection**, **segmentation**, and **classification** across both still images and video, with first-class auto-annotation (custom YOLO weights), interactive smart annotation (SAM 2 / SAM 3 — clicks, positive/negative prompts, text prompts), and object tracking across frames.

The product target is a "modern CVAT alternative" focused on:
- Better UI/UX (faster canvas, command palette, keyboard-first workflow).
- Easier deployment (one `docker compose up`, no Nuclio).
- Native integration of YOLO and SAM rather than serverless plug-in pattern.
- True video timeline (CVAT-class), unlike Ultralytics' 1 FPS / 100-frame cap.
- First-class **label remapping at export** (CVAT's #1 missing feature).

## 2. Goals (v1)

1. Manage projects, tasks, and jobs with images and videos.
2. Upload assets (images, videos, ZIP archives) and **import existing YOLO/COCO annotations** so a task can be opened pre-populated for review/correction.
3. Define classes with names, colors, and explicit IDs.
4. Annotate detection bboxes, segmentation polygons/masks, and classification tags.
5. Auto-annotate a whole task or selected images using a user-uploaded YOLO `.pt` weight (detection / segmentation / classification).
6. Smart annotation via SAM 2 / SAM 3:
   - Click-based (positive + negative clicks) → mask/polygon.
   - Text prompt (SAM 3 PCS) → multi-instance segmentation.
   - Object tracking across video frames or sequential images.
7. Annotate video frames via a real frame timeline with track/keyframe interpolation.
8. Class management with rename, color edit, ID remap **at export time**.
9. Export to YOLO and COCO formats (detection, segmentation, classification).
10. Per-class and per-task analytics: counts, distributions, dataset health.
11. Run on one machine with a single 4070 (16 GB) GPU. Single Docker Compose deployment.

## 3. Non-goals (v1)

- Multi-tenant SaaS, billing, payments.
- 3D / point cloud / DICOM / multispectral.
- **Pose / keypoint annotation** — explicitly v2.
- **Oriented bounding boxes (OBB)** — explicitly v2.
- Export formats beyond YOLO and COCO — explicitly out of v1 (VOC, KITTI, MOT, NDJSON all v2).
- Active-learning loops (v2).
- Real-time multi-user co-editing on the *same image at the same time* (v2; v1 supports multiple users on the same project but with per-job locking).
- LDAP/SAML/OIDC SSO (v1 ships local email + password accounts + JWT; SSO is v2).
- Mobile-optimized UI.

## 3a. Confirmed assumptions (from user)

- **Multi-user from day one.** MVP must support multiple annotators concurrently, with one Admin role and Member roles. Auth + role separation is in Phase 1.
- **Browser baseline: Chrome / Chromium-based browsers** (Chrome, Edge, Brave, Arc). WebGPU is assumed available; in-browser SAM decoder is the default. No fallback work for non-Chromium browsers in MVP.
- **Export formats v1: YOLO and COCO only.**

## 4. Personas

- **Annotator** — daily user. Opens an assigned task, annotates images/videos, leans on auto-annotate + SAM, submits the job.
- **Reviewer / Lead** — defines classes, sets up tasks, reviews jobs, runs batch auto-annotate, exports datasets.
- **Admin** — manages users, server settings, model uploads, storage.

(All three roles can be the same person on a small team. Permission model is simple: Admin / Member / Viewer at v1.)

## 5. Core Domain Model

```
User                ──┐
                      │ owns / is assigned to
Project ──┐           │
         (1..n)       │
          ▼           │
Task ─────────────────┤
 │                    │
 ├── Asset (image/video, content-addressed by XXH3-128)
 ├── Frame (for videos: timestamp + extracted thumbnail)
 ├── Class (name, color, integer id, attributes optional)
 ├── Annotation (Shape | Track)
 │     ├── Shape: polygon|mask|bbox|tag, frame_id, class_id, points
 │     └── Track: object_id, list of keyframes, interpolation rule
 ├── Job (slice of frames assigned to one annotator, status FSM)
 └── Export (YOLO/COCO snapshot, with optional class remap table)
```

- Project hierarchy: **Project → Task → Job** (CVAT-style).
- Project owns the **canonical class list** for its tasks.
- Task can be image-set or video; both treated uniformly internally (a video is a sequence of Frames).
- Tracks span frames; Shapes are single-frame.
- Class IDs at the project level are stable; export-time remapping is a separate Export config.

### Schema sketch (Postgres)

```sql
users           (id, email, password_hash, role, created_at)
projects        (id, name, description, owner_id, created_at)
tasks           (id, project_id, name, kind, created_at)            -- kind = 'image' | 'video'
assets          (id, task_id, kind, xxh3_128, mime, size_bytes,
                 width, height, frames, created_at)
frames          (id, asset_id, idx, pts_ms)                         -- video frames, lazily filled
classes         (id, project_id, idx, name, color, attributes JSONB)
annotations     (id, task_id, frame_id NULL, class_id, kind,
                 geometry JSONB, track_id NULL, created_by, updated_at)
tracks          (id, task_id, class_id, label JSONB)                -- keyframes via annotations.track_id
jobs            (id, task_id, assignee_id, frame_range int4range, status, stage)
exports         (id, task_id, format, class_remap JSONB, path, created_at)
```

`geometry` shape (JSONB) is one of:
- `{ "kind": "bbox", "x": 12, "y": 34, "w": 56, "h": 78 }`
- `{ "kind": "polygon", "points": [[x,y], ...] }`
- `{ "kind": "mask_rle", "size": [h, w], "counts": "..." }` — COCO RLE
- `{ "kind": "tag" }` — frame-level classification

## 6. System Architecture

Single machine. One Linux box with one **4070 (16 GB VRAM)**. Three logical services in Docker Compose, all on the same host. Inter-service traffic is internal only.

```
┌────────────────────────────────────────────────────────────────────────────┐
│  Browser (annotator)                                                       │
│  React + TS SPA · Pixi.js WebGL canvas · WebGPU SAM decoder · WebCodecs    │
└────────────┬───────────────────────────────────────────────────────────────┘
             │ HTTPS (REST + WebSocket)
             ▼
┌────────────────────────────────┐    ┌────────────────────────────────────┐
│  App service (FastAPI)         │    │  Model service (FastAPI, GPU)      │
│  - Auth, projects, tasks, jobs │◀──▶│  - Holds Torch processes in VRAM   │
│  - Classes, assets, exports    │    │  - SAM 3 (default at 16 GB)        │
│  - REST + WS endpoints         │    │  - SAM 2.1 (low-VRAM fallback)     │
│  - RQ workers (background)     │    │  - YOLO (Ultralytics) custom .pt   │
└──┬───────────┬────────────┬────┘    └────────────────────────────────────┘
   │           │            │
   ▼           ▼            ▼
┌──────┐  ┌─────────┐  ┌──────────────┐
│ PG   │  │ Redis   │  │ MinIO / FS   │
│ 16   │  │ 7       │  │ assets+exports│
└──────┘  └─────────┘  └──────────────┘
```

Why split web + model: lets us restart the web app without losing GPU state, lets us hot-swap a model without taking down the API, isolates ML crashes, lets us swap GPUs / move the model service to a remote box later without rewriting.

## 7. Inference Strategy on a 4070 (16 GB)

VRAM budget at FP16, single GPU:

| Resident component | Approx VRAM |
|---|---|
| CUDA + PyTorch baseline | ~1.5 GB |
| **SAM 3 large weights + activations** (1024² image) | ~5–6 GB |
| YOLO 11x detect (FP16) weights + activations | ~2–3 GB |
| Embedding cache + IO buffers | ~0.5–1 GB |
| Headroom | ~2–3 GB |
| **Total worst-case** | **~12–14 GB** |

**Default mode (16 GB GPU):** SAM 3 + YOLO **co-resident**. Click prompts, text prompts (PCS), and YOLO inference all available without model swap.

If a smaller GPU is provisioned later (8–12 GB), the model service auto-detects VRAM and falls back to:
- **SAM 2.1 Hiera-Large** (~225 MB weights, ~3–4 GB working) co-resident with YOLO; OR
- **Model swap mode**: hold YOLO; load SAM on demand, evict on idle.

YOLO weights (custom `.pt`) are loaded on-demand per task and cached in VRAM up to a small LRU (e.g., 2 active YOLO weights).

The encoder/decoder split is enforced for click latency:
- **Server-side encoder**: runs once per opened image, output cached in Redis as the `embedding_id`.
- **Browser-side decoder** (~15 MB ONNX via WebGPU): runs on every click, sub-30 ms response.
- **Server fallback decoder** for browsers without WebGPU.

Video tracking sessions are **pinned to the model worker process** for the duration of the session — SAM 2/3 video predictor maintains streaming state in-process. Cannot be load-balanced.

## 8. Annotation UI

### 8.1 Layout

Five zones, similar to CVAT but reorganized for clarity:

```
┌──────────────────────────────────────────────────────────────┐
│ Top bar: project · task · job · save · undo/redo · cmd palette│
├────┬───────────────────────────────────────────────┬─────────┤
│ T  │                                               │ Objects │
│ o  │                                               │ Classes │
│ o  │            Canvas (Pixi.js WebGL)             │ Issues  │
│ l  │                                               │         │
│ s  │                                               │ Stats   │
├────┴───────────────────────────────────────────────┴─────────┤
│ Bottom: frame timeline (videos) · image strip (images)       │
└──────────────────────────────────────────────────────────────┘
```

### 8.2 Tools palette (left rail)

- **Cursor / Pan / Rotate / Zoom-fit / ROI-zoom**
- **Bounding box** (drag corners; SHIFT for square)
- **Polygon** (click vertices, ENTER to close)
- **Polyline** (open path)
- **Brush / Eraser mask** (raster mask layer; mask↔polygon converters)
- **Magic wand → SAM** (click prompt, with hover preview before click)
- **Text → SAM 3** (modal: "describe what to segment"; returns multi-instance masks for review)
- **Tag** (frame-level classification)
- **Auto-annotate this image / this task** (runs YOLO with chosen `.pt` weight)
- **Track propagate** (SAM 2/3 video tracker forward N frames)

### 8.3 Right panel tabs

- **Objects**: per-frame list with lock, hide, occluded, lock-z, color-by toggle.
- **Classes**: project class list, hotkey 1–9 + fuzzy quick-switch (Cmd+L) for >9 classes.
- **Issues**: review comments threaded on shapes (v2 priority — basic in v1).
- **Stats**: live per-class count for the current task and totals.

### 8.4 Canvas — performance budget

- Render up to **5,000 shapes per frame at 60 fps** on a mid-range laptop (we exceed CVAT's effective ceiling of ~800 shapes).
- Achieved by Pixi.js WebGL with shape batching. SVG is not used in the hot path.
- Virtualized objects sidebar (windowed list) to handle 10k+ rows.
- Image decode via WebCodecs where supported; fall back to `<img>` for compatibility.

### 8.5 Keyboard-first

Command palette `Cmd/Ctrl+K`: switch class, jump to frame, run auto-annotate, change tool, change workspace.

Hotkeys:
- `1`–`9` set class for next-drawn shape (top 9). Cmd+L for fuzzy switcher.
- `B/P/M/R` — bounding box / polygon / mask brush / rectangle quick switch.
- `S` — SAM click mode.
- `T` — track propagate.
- `K` — toggle keyframe.
- `O` — toggle outside (object disappeared on this frame).
- `[` / `]` — prev / next keyframe.
- `Space` — play/pause video.
- `Cmd+Z / Cmd+Shift+Z` — undo / redo (linear, scoped to the current job).

## 9. Auto-Annotation Features

### 9.1 Custom YOLO weights

User uploads a `.pt` weight (Ultralytics format) at the project or task level. Backend validates:
- Loadable by `ultralytics` lib.
- Task type (detect / segment / classify) matches.
- Model class names mappable to project classes (UI for mapping with preview).

User can:
- Run on **a single image** (toolbar button, results appear as editable shapes).
- Run on **all unannotated frames** of a task (background RQ job; progress in UI).
- Run on **all frames** including replacing existing (with an explicit "overwrite" gate).

Confidence threshold and IoU dedup threshold are user-controllable. Predictions land as draft shapes that the user reviews.

### 9.2 SAM smart annotation — click mode

Encoder runs server-side once per image; embedding cached. Decoder runs **in the browser** via WebGPU. Each click renders the new mask in < 30 ms.

Workflow:
1. User picks SAM tool.
2. Image embedding fetched (or pulled from cache) on first click.
3. Left-click adds a positive point; right-click adds a negative point.
4. Hover preview shows the candidate mask before clicking, so users can pre-judge.
5. `Enter` accepts, `Esc` cancels. Auto-apply mode commits on each click without confirm.
6. Mask is converted to polygon (Douglas-Peucker, configurable epsilon) by default; user can keep raster mask.

### 9.3 SAM 3 text-prompt mode (PCS)

User opens "Describe and segment" modal. Types a noun phrase (e.g., "yellow school bus", "person with backpack"). SAM 3 returns multiple candidate masks across the image with scores. User accepts/rejects per instance. Integrated with class assignment: pick a class, type a phrase, receive multi-instance pre-labels.

On a 16 GB 4070, runnable per-image but slower than click mode (whole-image inference, not encoded-then-decoded). Used as a "describe and pre-label" feature, not the default click flow.

### 9.4 Tracking — interactive across frames

For both video tasks and image-sequence tasks (e.g., scientific sequences), SAM 2/3 video tracking propagates a mask across frames:

1. Annotator labels object on frame N (any tool).
2. Selects "Track forward" → choose number of frames or "until end of segment".
3. Backend opens a streaming session; pinned to one model worker.
4. Frontend shows a progress strip; predicted masks per frame appear on the timeline as keyframes.
5. Annotator scrubs and corrects drift; corrections re-anchor the track.
6. Linear interpolation is fallback for non-mask shapes (bbox/polygon).

Fallback if SAM tracker unavailable or for bbox-only: **OpenCV trackers (CSRT)** + linear interpolation.

## 10. Video & Frame Handling

- Videos uploaded directly. **No 1 FPS / 100-frame cap**. Default sample rate is "every frame" up to a configurable max (e.g., 100k frames per task).
- Frames extracted lazily by RQ workers using FFmpeg; thumbnails generated for the timeline strip.
- Streaming playback via HLS for >1 GB videos. Frame-by-frame mode uses the keyframe index; intra-frames decoded on-demand by WebCodecs in the browser when supported.
- Video timeline (bottom) shows all keyframes per track, color-coded by class. Drag to scrub.
- Image-set tasks reuse the same timeline as a thumbnail strip — uniform UX between video and images.

## 11. Class / Label Management

- Classes are project-level. Each class has: integer `id` (auto-assigned, editable), `name`, `color` (palette + custom picker), optional `attributes` (string/number/bool, mutable/immutable).
- Add / rename / recolor / reorder classes any time.
- Deleting a class with existing data prompts: **reassign to another class** or **delete annotations**. Block until resolved.
- **Hotkeys 1–9** auto-bind to first nine classes; rest accessible via fuzzy switcher (Cmd+L).
- **Class taxonomy** (parent/child) is v2.

### Export-time remapping (key differentiator)

Export modal shows a class-mapping table:

| Project class | → | Export class id | Export class name | Include? |
|---|---|---|---|---|
| 0  car | → | 0 | vehicle | ✓ |
| 1  truck | → | 0 | vehicle | ✓ |
| 2  pedestrian | → | 1 | person | ✓ |
| 3  cyclist | → | (skip) | — | ✗ |

User can:
- Merge classes (multiple → one).
- Skip classes entirely.
- Rename for export only (project class stays unchanged).
- Save mappings as named presets per project.

## 12. Export Pipeline

Formats supported in v1:
- **YOLO** (txt per image, `data.yaml` with class names) — detection, segmentation, classification.
- **COCO JSON** — detection (bbox), segmentation (polygons + RLE for masks), classification.

v2: VOC, KITTI, MOT, Datumaro, Ultralytics NDJSON.

Export job:
1. User opens Export modal on a task.
2. Picks format, applies optional class-remap preset, picks include/exclude filters (split = train/val/test, only labeled, etc.).
3. RQ worker streams output to MinIO; user downloads ZIP when ready.
4. Export is **immutable** — every export is a versioned snapshot; revisit anytime.

## 13. Analytics

Per-task and per-project dashboards (free, in-product):

- **Class frequency** bar chart (counts per class).
- **Annotation density** per image / frame.
- **Task progress** (annotated vs total, per assignee).
- **Object size distribution** (small/medium/large per COCO definition).
- **Spatial heatmap** — where in the frame objects fall (Ultralytics-style).
- **Aspect ratio histogram** of annotated objects.
- **Time-on-task** per annotator (basic, not paywalled).

Data sourced from a `frame_stats` materialized view + Redis-backed event log.

## 14. Auth & Permissions

- Local accounts with email + password, JWT bearer, refresh tokens.
- Roles: **Admin** (manages users, models, server config), **Member** (own projects, annotate), **Viewer** (read-only).
- Per-project membership: project owner can add/remove members.
- v2: SSO via OIDC, project-level role overrides, audit log.

Passwords hashed with Argon2id. Rate-limit on login. CSRF protection on state-changing endpoints (double-submit cookie).

## 15. Tech Stack

| Layer | Choice | Reason |
|---|---|---|
| Frontend framework | React 19 + TypeScript 5.x | Largest ecosystem, mature tooling for canvas-heavy apps |
| Build / dev | Vite 6 | Fast HMR, native TS, ESM-first |
| State | Zustand + TanStack Query | Local + server-state separation; URL state in router |
| Canvas | Pixi.js v8 (WebGL2) | 60 fps with thousands of shapes; CVAT's SVG approach is the perf bottleneck |
| Video | WebCodecs + HLS.js fallback | Frame-accurate, hardware decoded |
| SAM in-browser | onnxruntime-web (WebGPU) | Decoder ~15 MB; sub-30 ms click latency |
| Routing | TanStack Router | Type-safe, file-based |
| Forms | React Hook Form + Zod | Schema-validated, ergonomic |
| Styling | Tailwind v4 + CSS variables for tokens | Avoids "looks like a template" — design tokens enforced |
| Backend | FastAPI (Python 3.12) + Uvicorn | Async, OpenAPI free, ML libraries all Python |
| ORM | SQLAlchemy 2 + Alembic | Strong types, mature migrations |
| DB | PostgreSQL 16 | JSONB for annotation payloads, pgvector later for semantic search (v2) |
| Cache / queue | Redis 7 + RQ | Simpler than Celery, fine for our scale |
| Asset store | MinIO (S3-compatible) | Same API as cloud S3, easy to migrate later |
| Inference | PyTorch 2.7 + Ultralytics + facebookresearch/sam3 | Native model support |
| Container | Docker + Compose v2 | One `docker compose up` |
| GPU runtime | NVIDIA Container Toolkit | Standard on modern Linux |
| Observability | OpenTelemetry → Loki/Grafana (optional) | Off by default, opt-in |

## 16. Deployment Topology

Single Compose file. Profiles: `dev`, `prod`, `gpu`.

```
services:
  app:        FastAPI web (REST + WS)
  worker:     RQ background workers
  model:      FastAPI inference (GPU pinned via runtime: nvidia)
  postgres:   Postgres 16
  redis:      Redis 7
  minio:      MinIO single-node
  caddy:      reverse proxy + automatic TLS (LAN-friendly)
```

`docker compose --profile gpu up -d` brings the whole stack up. First-run wizard creates an admin user.

Storage volumes: `pg_data`, `minio_data`, `model_cache` (downloaded weights) — all on the host disk, easy to back up.

## 17. Security

- HTTPS everywhere via Caddy + self-signed cert by default; admin can swap in real cert.
- All model uploads scanned: file size cap, MIME check, weights de-pickled inside a constrained subprocess (the `.pt` format is Pickle — we use `weights_only=True` and pin to Ultralytics' approved class list).
- File uploads streamed to MinIO; backend never holds the full file in memory.
- CSP with nonce on inline scripts; `default-src 'self'`.
- Rate limit on auth + upload endpoints.
- No secrets in code; all via env vars; `.env.example` shipped, `.env` gitignored.
- Per-project access enforced at the API layer (FastAPI dependency); also at the SQL layer via row-level filters.

## 18. Performance Budget

- Page load: TTI < 2.5 s on cold cache.
- Frame switch: < 200 ms on a hot canvas.
- SAM click → mask: < 50 ms (decoder in browser).
- SAM encoder run: < 1.2 s per image on the 4070 (SAM 3) / < 0.8 s (SAM 2.1-L).
- YOLO inference per image: < 200 ms (640 px) on the 4070.
- Auto-annotate batch: ≥ 10 img/s sustained.
- Concurrent annotators (target): 8 active sessions on the 4070 with mixed workload.

## 19. Testing Strategy

- **Unit tests**: pytest for backend, Vitest for frontend. Target ≥ 80 % line coverage.
- **Integration tests**: spin up Postgres + Redis + MinIO via Compose in CI, exercise REST + RQ jobs.
- **Model service tests**: a CPU-only mock model implementing the same interface (no GPU in CI).
- **E2E**: Playwright. Critical flows: create project, upload image, run SAM click, run YOLO auto-annotate, export YOLO + COCO.
- **Visual regression**: Playwright screenshots for the canvas at known-good states.
- **Load test**: Locust for sustained RQ throughput.

## 20. Roadmap

### MVP (Phase 1) — ~6–8 weeks of focused work

- **Multi-user auth from day one**: email + password, JWT, Admin + Member roles, per-project membership.
- Projects, tasks, classes.
- Image upload (single + ZIP).
- **Annotation import (YOLO + COCO)** so existing labels can be opened for review.
- Detection (bbox), segmentation (polygon + mask), classification (tag).
- Manual annotation; basic class hotkeys; command palette; objects sidebar; analytics widgets.
- YOLO auto-annotate (single image + whole task) for detection + segmentation + classification.
- **YOLO + COCO export** with class remap.
- Per-class analytics (counts, frequencies, task progress).
- Single Docker Compose deployment.

### Phase 2 — SAM + video — ~4–6 weeks

- SAM 3 click-mode integration (encoder server, decoder browser; SAM 2.1 fallback).
- SAM video tracker (forward propagation).
- Video upload + frame timeline + tracks + interpolation.
- Annotation import (YOLO + COCO).

### Phase 3 — SAM 3 polish — ~3–4 weeks

- SAM 3 text-prompt mode (PCS) integrated as "Describe and segment".
- Hover preview for SAM clicks.
- Auto-apply mode toggle.
- Spatial heatmap analytics.
- Issue threads (lightweight review).
- Docs site.

### Phase 4+ (v2)

- Pose/keypoints, OBB.
- Active learning (uncertainty sampling).
- SSO (OIDC).
- Real-time collaboration.
- Class taxonomy / attributes.
- Additional export formats.

## 21. Risks & Open Questions

| Risk | Mitigation |
|---|---|
| 4070 16 GB still tight if user wants SAM 3 + heavy YOLO at full resolution | Quantize where safe; provide model-swap fallback; document VRAM requirements. |
| Pickle (`.pt`) supply-chain risk on YOLO uploads | `weights_only=True` + sandboxed subprocess + Ultralytics class allowlist. |
| Video memory on long videos | Lazy frame extraction + bounded RQ memory; HLS streaming. |
| Browser compatibility (WebGPU) | Detect; fall back to server decoder when WebGPU absent. |
| Long video tracking session pinned to one process — single point of failure | Persist memory bank to Redis snapshots so a worker restart can resume; document cap. |

Open questions — **resolved by user 2026-04-25**:
1. Pose/keypoints — **v2** ✓
2. OBB — **v2** ✓
3. Multi-user from day 1 — **yes**, MVP includes multi-user auth + single Admin ✓
4. Export formats v1 — **YOLO + COCO only** ✓
5. WebGPU baseline — **yes**, all annotators use Chromium-based browsers; in-browser SAM decoder is the default ✓

## 22. Repository Layout (planned)

```
VisualAutoAnnotator/
├── docker-compose.yml
├── docker-compose.gpu.yml
├── apps/
│   ├── web/                 # React + TS frontend
│   │   ├── src/
│   │   ├── package.json
│   │   └── vite.config.ts
│   ├── api/                 # FastAPI app service
│   │   ├── src/
│   │   ├── alembic/
│   │   └── pyproject.toml
│   └── model/               # FastAPI model service (GPU)
│       ├── src/
│       └── pyproject.toml
├── packages/                # shared TS / Python utility libs
│   ├── annotation-types/    # shared TS types for shapes/tracks/exports
│   └── exporter/            # shared YOLO/COCO writer
├── docs/
│   └── superpowers/
│       ├── specs/           # this file lives here
│       └── plans/
└── infra/
    ├── caddy/
    ├── postgres/
    └── minio/
```

## 23. Naming and Branding

Working name: **VisualAutoAnnotator**.

Short slug for code paths and CLI: **vaa**.

Public branding TBD post-MVP.

---

## Approval Checklist

- [ ] Domain model (Project / Task / Job / Class / Annotation / Track) is correct.
- [ ] Inference strategy (SAM 3 default at 16 GB, SAM 2.1 fallback, YOLO co-resident) is acceptable.
- [ ] UI layout (5 zones, left tools / right panel / bottom timeline) matches expectations.
- [ ] Export-time class remapping is the right model.
- [ ] MVP feature scope is the right starting line.
- [ ] Tech stack choices are acceptable.
- [ ] Roadmap phasing is acceptable.
- [ ] Open questions answered.
