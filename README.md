# Carve

**On-premises, web-based annotation platform for computer-vision datasets.**

Carve is a self-hosted, multi-user annotation suite for detection, segmentation, and classification — with SAM 2.1 / SAM 3.1 smart annotation, YOLO auto-annotate, active-learning retraining, QA review, and a full project-management layer. Built for teams who need complete data control and GPU inference on their own hardware.

[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL%203.0-blue.svg)](LICENSE)
[![GitHub Sponsors](https://img.shields.io/badge/Sponsor-%E2%9D%A4-ea4aaa?logo=github-sponsors)](https://github.com/sponsors/Rm1n90)
[![GitHub release](https://img.shields.io/github/v/release/Rm1n90/Carve)](https://github.com/Rm1n90/Carve/releases)


---

## Features

### Annotation tools

| Tool | Shortcut | Notes |
|---|---|---|
| Bounding box | `B` | Drag to draw; resize handles; bulk reassign |
| Polygon | `P` | Click-to-place vertices; alt-click inserts on an edge; vertex drag |
| Mask brush | `M` | Adjustable radius + hardness; eraser toggle; RLE-stored |
| Tag / classification | `T` | Frame-level or asset-level label |
| SAM smart select | `S` | Click positive/negative points; WebGPU decoder (<30 ms) |

- **Canvas marquee selection** — drag-select multiple annotations, then bulk-reassign class in one action
- **Right-click context menu** — CVAT-quality: rename, reassign, delete, copy ID; hover submenu for class pick; viewport-clamped positioning
- **Type-to-filter** quick-reassign overlay on any selected annotation
- **Class command palette** — `C` opens a searchable palette with pinned + recent classes
- **Polygon vertex insert** — hover an edge to see a ghost vertex; alt-click to commit
- **Mask brush hardness** slider + eraser toggle in the toolbar
- **Undo grouping** — contiguous edits coalesce into a single undo step
- **Keyboard cheat sheet** — `?` opens the full shortcut reference

### SAM / AI smart annotation

- **SAM 2.1** (tiny · small · base-plus · large) — positive/negative click prompts; browser-side WebGPU ONNX decoder; server-side fallback
- **SAM 3.1** — text prompts ("person", "yellow truck") and box prompts; concept-based segmentation
- **SAM mode selector** — switch between click, box, and text within the editor toolbar
- **Auto-apply** — mask committed immediately on each click without a confirm step
- **CVAT-style live preview** — mask outline updates while placing points
- **Model VRAM management** — lazy load on first use, LRU eviction keeps memory bounded

### YOLO auto-annotate

- **Single-asset predict** — run any loaded YOLO11/YOLO26 weight over the current image
- **Batch predict** — run over an entire task; real-time progress overlay (asset count + annotations created)
- **Overwrite guard** — pre-flight warning + confirm dialog before replacing existing annotations
- **Class mapping** — remap model output names to project labels at predict time; unmapped classes surfaced in toast
- **FP16 inference** — half-precision toggle for 2× throughput
- **IOU threshold** — configurable per-predict slider
- **Weight assignments** — assign a default YOLO weight per project/task scope; inline row editor

### Annotation review & QA

- **Per-annotation review** — accept or reject individual annotations in a dedicated review panel
- **Reviewer identity** — reviewer name displayed per decision; role-gated
- **Accepted-status badge** — checkmark overlay on accepted annotations in the canvas
- **Auto-reset on edit** — editing a reviewed annotation clears its review status
- **Prev-revision compare overlay** — toggle a semi-transparent paint of the previous annotation revision on the canvas
- **Bulk review guards** — concurrent mutation protection

### Active learning & retraining (BETA)

- **One-click retrain** — "Retrain YOLO" from the task toolbar launches a fine-tune job on accepted annotations
- **Retrain RQ job** — enqueued to the model worker; progress tracked in the datasets tab
- **Dataset versioning** — every retrain/export/rollback creates a `DatasetVersion` snapshot
- **Version diff** — compare any two versions side-by-side with a visual diff of added/removed annotations
- **Rollback** — revert to any previous version in one click
- **Weight metadata** — retrain metrics (mAP, epochs, duration) stored on the weight record

### Task & project management

- **Task due dates** — set a deadline on any task; overdue tasks shown with a red tint and warning icon
- **Upcoming-due strip** — top-of-page widget on the project detail page lists nearest deadlines in priority order
- **Task timestamps** — created-at displayed on each task row
- **Task archive** — archive completed tasks with restore; filter bar includes an Archived tab
- **Project pinning** — pin frequently accessed projects; they float to the top of the index
- **Recent projects** — automatically tracked; shown as a dedicated filter tab
- **Project roles** — owner / member scoping at the project level, separate from workspace roles

### Projects & navigation

- **Projects index** — full-text search, sort (name / updated / created), filter (all / pinned / recent), virtualised list
- **Cmd-K global search** — fuzzy search across projects, tasks, and assets from anywhere
- **Per-task saved views** — save a filter+sort combination as a named view; shareable via URL
- **Asset search** — search within a task by filename or annotation class
- **Breadcrumb navigation** — project → task → asset path always visible in the editor header
- **Sticky toolbar** — editor toolbar stays in view at narrow widths; tools reflow instead of wrapping

### Analytics & quality dashboard

- **Stats tab** — class frequency chart, annotation size distribution, aspect-ratio buckets, spatial heatmap, time-on-task breakdown per annotator
- **Quality dashboard tab** — reviewer-quality chart (accept/reject ratio per reviewer), per-class quality scores, retrain history with metric trend lines
- **Project-level aggregates** — stats roll up across all tasks in a project

### Collaboration & access control

- **Role-based access** — workspace roles: `admin` / `annotator`; per-project member scoping
- **Per-project invitations** — invite by email; tokens expire; accept flow with landing page
- **Member management** — promote, demote, and remove workspace members from the admin UI
- **SSO / OIDC** — Google adapter included; other providers wired via the OIDC entry point
- **Audit log** — records review decisions, retrain launches, exports, and task deletions with actor + timestamp
- **API key auth** — `Bearer ck_<token>` keys for headless and CI pipelines; Argon2-hashed at rest
- **First-run admin wizard** — bootstraps the first admin account on a fresh database

### Import / Export

- **YOLO export** — detection or segmentation format; per-class remap; train/val/test split
- **COCO export** — full instance-segmentation JSON; configurable split
- **YOLO import** — load existing YOLO label files alongside images
- **COCO import** — ingest COCO JSON annotations into a task

### Infrastructure

- **Docker Compose** — single `docker compose up -d --build`; no Kubernetes required
- **TLS via Caddy** — automatic Let's Encrypt certificates
- **MinIO** — S3-compatible object storage; scripted Postgres + MinIO backup and restore
- **Redis + RQ** — background job queue for retrain and batch predict; worker timeout/retry + traceback capture
- **Lazy model loading** — SAM and YOLO never claim VRAM until used; LRU eviction keeps memory bounded
- **Route-level code splitting** — each page is a separate JS chunk; bundle budget enforced in CI
- **Asset thumbnail virtualisation** — paginated fetch + virtual scroll for large tasks
- **VitePress operator docs** — mounted at `https://<domain>/docs`

---

## Quick Start

```bash
git clone https://github.com/Rm1n90/Carve.git
cd Carve
cp .env.example .env
# Edit .env: set POSTGRES_PASSWORD, MINIO_ROOT_PASSWORD, JWT_SECRET, CARVE_DOMAIN
docker compose up -d --build
```

Visit `https://<CARVE_DOMAIN>`. On a fresh database the **First-run admin wizard** appears to create the bootstrap admin account.

**GPU is optional.** Manual annotation, import/export, QA, and project management run on CPU. An NVIDIA GPU + [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html) is required only for SAM and YOLO inference.

Full setup guide → [Wiki: Getting Started](https://github.com/Rm1n90/Carve/wiki/Getting-Started)

---

## System Requirements

| Requirement | Details |
|---|---|
| OS | Linux x86\_64 (Ubuntu 22.04+); macOS for local dev only |
| Docker | 26+, Compose v2 |
| GPU (inference only) | NVIDIA + CUDA 12.6 + NVIDIA Container Toolkit |
| VRAM — SAM 2.1 large | ~9 GB |
| VRAM — SAM 3 | ~12 GB |
| Disk | ~12 GB image cache + asset volume |

SAM size guide: `tiny` ~3 GB · `small` ~4 GB · `base-plus` ~6 GB · `large` ~9 GB · `sam3` ~12 GB. YOLO weights load on demand (LRU capacity 2), independent of SAM.

---

## Documentation

Full documentation lives in the [Wiki](https://github.com/Rm1n90/Carve/wiki):

| Topic | Link |
|---|---|
| Getting started | [Wiki: Getting Started](https://github.com/Rm1n90/Carve/wiki/Getting-Started) |
| Environment variables | [Wiki: Environment Variables](https://github.com/Rm1n90/Carve/wiki/Environment-Variables) |
| SAM model selection | [Wiki: SAM Models](https://github.com/Rm1n90/Carve/wiki/SAM-Models) |
| YOLO auto-annotate | [Wiki: YOLO](https://github.com/Rm1n90/Carve/wiki/YOLO) |
| Export formats | [Wiki: Export](https://github.com/Rm1n90/Carve/wiki/Export) |
| Backups & restore | [Wiki: Backups](https://github.com/Rm1n90/Carve/wiki/Backups) |
| Troubleshooting | [Wiki: Troubleshooting](https://github.com/Rm1n90/Carve/wiki/Troubleshooting) |
| Admin & operations | [Wiki: Admin](https://github.com/Rm1n90/Carve/wiki/Admin) |
| Local development | [Wiki: Local Development](https://github.com/Rm1n90/Carve/wiki/Local-Development) |

Operator docs also ship as a live VitePress site at `https://<CARVE_DOMAIN>/docs`.

---

## Contributing

Contributions are welcome. Open an issue before starting significant work so we can align on direction.

1. **Open an issue first** for bugs, feature requests, or design discussions.
2. **Fork the repo** and create a branch from `master`:
   ```bash
   git checkout -b feat/my-feature
   ```
3. **Follow code style** — Ruff + Black for Python, ESLint + Prettier for TypeScript.
4. **Write tests** — PRs without tests for new behaviour will not be merged.
5. **Use conventional commits**:
   ```
   feat: add polygon simplification tool
   fix: correct SAM decode on high-DPI screens
   ```
6. **Open a pull request** against `master` with a clear description of what changed and why.

Branch conventions: `feat/` · `fix/` · `refactor/` · `docs/` · `chore/`

---

## Release History

| Version | Highlights |
|---|---|
| **v3.13.0** | Right-click menu polish · task due dates + archive · toolbar icon parity · Projects hero · upcoming-due strip · public README |
| **v3.12.0** | Projects search/sort/filter/pin · class command palette · canvas marquee select · right-click context menu · asset multi-select |
| **v3.11.0** | Cmd-K global search · saved views · quality dashboard · datasets versioning/diff/rollback · SSO/OIDC · audit log · per-project invitations |
| **v3.10.x** | SAM 3.1 native image predictor (point / box / text) · Object Multiplex video tracker |
| **v3.9.x** | Annotation review/QA panel · prev-revision compare · one-click YOLO retrain · polygon vertex insert · mask hardness + eraser · undo grouping |
| **v3.7.x** | YOLO batch predict + progress overlay · FP16 inference · IOU slider · weight assignments · overwrite guard |
| **v3.6.0** | SAM CVAT-style live preview · predict 502 fix |
| **v3.5.0** | Inference UX overhaul — SAM full modes, progress UI, predict-time class mapping |
| **v3.4.0** | Model service migrated to Hugging Face transformers |
| **v3.3.0** | Stats tab · project meta · YOLO classes · weight selection |
| **v2.0.0** | 3-column editor · Settings family · Trash · API key auth |
| **v1.x** | SAM model selector · bf16 · torch.compile · TLS · first-run wizard · YOLO + SAM 2 inference · video tracking |

Full changelog → [GitHub Releases](https://github.com/Rm1n90/Carve/releases)

---

## Sponsorship

Carve is free and open-source under AGPL-3.0. If it saves you time or infrastructure cost, please consider sponsoring development:

[![Sponsor on GitHub](https://img.shields.io/badge/Sponsor%20Carve-%E2%9D%A4-ea4aaa?style=for-the-badge&logo=github-sponsors)](https://github.com/sponsors/Rm1n90)

---

## License

[AGPL-3.0](LICENSE) © 2026 [Armin Mehri](mailto:mehri.armin@gmail.com)
