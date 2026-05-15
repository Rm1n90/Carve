# Admin & operations


## User management

The first visit to the app triggers the **First-run admin wizard**, which creates the bootstrap admin account. After that:

- Public self-registration is disabled.
- Admins can create new accounts at `/auth/register` (admin-only route).
- User roles: **admin** (full access) and **annotator** (project-scoped access).
- Admins manage members via **Settings → Members** in the web UI.

## API keys (v2.0)

API keys let you call the Carve API from headless clients (CI scripts, custom tooling, batch import jobs). They authenticate the same way JWT tokens do — `Authorization: Bearer <token>` — and grant the same permissions as the user that owns the key.

### Create a key

1. Sign in to the web UI.
2. Open **Settings → API keys**.
3. Click **New key**, give it a descriptive name (e.g. `ci-import-2026q2`), and submit.
4. The plaintext token is displayed **once** with a `ck_` prefix — copy it now. The server only stores an Argon2 hash; if you lose the plaintext you must create a new key.

### Use a key

```bash
curl -fsS https://your-carve-host/api/projects \
  -H "Authorization: Bearer ck_aBcDe..."
```

### Revoke a key

In the web UI, click **Revoke** next to the key. Revoked keys are rejected on the next request (no JWT-style replay window since keys are validated against the database on every call).

### Storage

Tokens are stored as Argon2 hashes in the `api_keys` table along with a non-secret `prefix` (the first 12 chars) used as an indexed lookup. The plaintext is never logged or persisted.

## Trash & restore (v2.0)

Project and task deletes are **soft** by default: the row is marked with `deleted_at = now()` and hidden from the standard listing. Soft-deleting a project also soft-deletes all of its tasks at the same timestamp, so restore is symmetric.

- The **/trash** page (top-level nav) lists all soft-deleted projects and tasks the user can see.
- **Restore** clears `deleted_at` and the item reappears in its parent listing.
- **Permanent delete** is admin-only and triggers `ON DELETE CASCADE` on assets/annotations/frames. There is no undo.

## Models page (v2.0)

The **Models** section under Settings provides operator-facing views into the inference stack:

- **Models → SAM**: shows all five SAM variants (`sam2.1-tiny`, `sam2.1-small`, `sam2.1-base-plus`, `sam2.1-large`, `sam3`) and indicates which one is active. Switching the active variant requires editing `SAM_MODEL` in `.env` and restarting the model container — see [SAM model selection](#sam-3-toggle).
- **Models → YOLO**: lists uploaded custom YOLO weights and lets you upload new `.pt` files. Weights are stored in MinIO and loaded lazily by the model service.

## Model service (v3.4)

The inference container (`model`) is **opt-in** behind the `inference`
docker-compose profile. The editor stack (api / web / worker / postgres /
redis / minio) runs without it; manual annotation tools never call the
model service.

```bash
# Start the model container
docker compose --profile inference up -d model

# Stop it (editor keeps running)
docker compose --profile inference stop model
```

### Backend

As of v3.4 the model service runs SAM 2.1 entirely on Hugging Face
`transformers` (`Sam2Model` + `Sam2Processor` for image, `Sam2VideoModel`
+ `Sam2VideoProcessor` for video). The previous upstream `sam2` git
package path was removed in v3.4 commit 6 — there is no toggle to opt
back in. SAM 3 routes through the same transformers path via
`Sam3Model` / `Sam3VideoModel` / `Sam3TrackerModel` /
`Sam3TrackerVideoModel`.

### Variant selection

Default variant is `sam2.1-large`. To switch:

- **Permanent:** edit `SAM_MODEL` in `.env` and restart the container.
- **Hot swap (admin):** `POST /sam/switch {"variant": "sam2.1-small"}`
  on the model service's internal port. The current predictor is
  evicted and the new variant is loaded lazily on the next request.

Valid values: `sam2.1-tiny`, `sam2.1-small`, `sam2.1-base-plus`,
`sam2.1-large`, `sam3` (gated — see [SAM 3](#sam-3-toggle)).

### HF cache volume

Weights are cached at `/root/.cache/huggingface` inside the container,
backed by the named volume `carve-hf-cache`. The volume persists across
`docker compose build` and `up -d` cycles, so a rebuild does not force
a re-download of multi-gigabyte SAM weights. To wipe the cache:

```bash
docker compose --profile inference down model
docker volume rm carve-hf-cache
```

### Pre-warm (optional)

Predictor loading is lazy by default — the first `/sam/encode` call
pays the load cost. To warm the active predictor before the first
request (e.g. after a deploy):

```bash
docker compose --profile inference exec model \
  python -c "from carve_model.sam.predictor import get_predictor; get_predictor()"
```

This loads the variant configured by `SAM_MODEL` into GPU memory and
caches the singleton. Subsequent `/sam/encode` calls hit the cached
predictor immediately. The `SAM_PREWARM` env var is reserved for a
future container-startup hook; it is not yet wired.

## MinIO public endpoint (v2.0)

The browser fetches assets via presigned URLs that point at MinIO. Inside the docker network the API reaches MinIO at `http://minio:9000`, but the browser cannot resolve `minio` — it needs a host-reachable URL.

`MINIO_PUBLIC_ENDPOINT` is the env var that controls the URL embedded in presigned responses for the browser. Two-client behavior:

- `MINIO_ENDPOINT` (e.g. `http://minio:9000`): used by the API/worker for server-side I/O (`put_object`, `get_object`, `head_bucket`).
- `MINIO_PUBLIC_ENDPOINT` (e.g. `http://localhost:9000` in dev, `https://minio.example.com` in prod): used to sign the URLs the browser follows.

When `MINIO_PUBLIC_ENDPOINT` is unset (or equal to `MINIO_ENDPOINT`), Carve falls back to a single shared client — no surprise change for existing deployments.

## Backups

A backup script is provided at `scripts/backup.sh`. It dumps Postgres and snapshots the MinIO bucket to a local archive directory.

Recommended cron (daily at 03:00):

```cron
0 3 * * * /path/to/repo/scripts/backup.sh >> /var/log/carve-backup.log 2>&1
```

### Restore

Follow the "Backups & restore" section in the project `README.md` for the full restore procedure.

## SAM 3 (concept-based segmentation + tracking) — admin setup {#sam-3-toggle}

SAM 3 is a unified model that performs Promptable Concept Segmentation
(PCS): text-driven detection + segmentation on images, plus video object
tracking where the model auto-detects ALL matching instances and tracks
them across frames. The model is gated on Hugging Face (`facebook/sam3`)
and is **not** installed by default — the operator must accept the
license and provide an HF token before enabling it.

- **SAM model selection (v1.1):** set `SAM_MODEL` to one of `sam2.1-tiny`,
  `sam2.1-small`, `sam2.1-base-plus`, `sam2.1-large` (default), or `sam3`.
  The legacy `SAM_VARIANT` env (`sam2` / `sam3`, from Plan 08) is still
  honored for backward compatibility when `SAM_MODEL` is unset.
- **Performance:** SAM inference runs in bf16 by default on Ampere+ GPUs
  (RTX 30/40 series, A100, H100) for roughly half the VRAM and ~2x the
  throughput vs FP32. Set `SAM_BF16=0` to force FP32 for debugging.
- **torch.compile (optional):** Set `SAM_COMPILE=1` for ~1.3-2x faster
  inference after a one-time 30-60s warmup. Falls back gracefully on
  incompatible hardware.
- **SAM 2.1 backend (v3.4):** SAM 2.x runs on Hugging Face `transformers`
  (`Sam2Model` + `Sam2Processor` for image, `Sam2VideoModel` +
  `Sam2VideoProcessor` for video). Weights are cached at
  `/root/.cache/huggingface` inside the model container. The legacy
  upstream `sam2` git package path was removed in v3.4 commit 6; no
  toggle to opt back in.
- **GPU memory management:** SAM models are unloaded from GPU memory
  after `SAM_IDLE_TIMEOUT_S` seconds of inactivity (default `900` =
  15 min). Set to `0` to disable idle eviction. Force-unload immediately
  via `POST /sam/unload` (admin endpoint inside the model service network;
  not proxied through Caddy). The body accepts
  `{"which": "image" | "tracker" | "all"}` (default `"all"`); the
  response lists what was actually freed.

When the active SAM variant does not support text prompts (e.g. the
default `sam2.1-large`, or any sam2.x variant), the
`POST /sam/text-prompt` endpoint returns
`409 text_prompt_not_supported_for_variant`. The rest of the SAM 2
surface (`/sam/encode`, `/sam/decode`, sam-track) is unaffected. The
gate is capability-based, not variant-name-based — switch to a variant
whose adapter advertises `supports_text` (e.g. `sam3`) to enable it.

### Enable

1. Accept the [facebook/sam3](https://huggingface.co/facebook/sam3) license
   on Hugging Face.
2. Generate a HuggingFace access token with **read** scope.
3. In your `.env`, set:

   ```env
   SAM_MODEL=sam3
   HF_TOKEN=hf_xxx
   ```

4. Make sure `transformers>=5.6` is included in the model service `[gpu]`
   extras (it carries the `Sam3Model` / `Sam3VideoModel` classes).
5. Rebuild and restart the model service:

   ```bash
   docker compose build model && docker compose up -d model
   ```

### SAM 3 prompt support — corrected (v1.3.0)

SAM 3 ships **four** distinct transformers classes (per the
[`facebook/sam3`](https://huggingface.co/facebook/sam3) model card,
transformers v5.6.x). v1.3.0 wires each prompt route to the correct class:

- `Sam3Model` (image, **concept**) — text + boxes (no points)
- `Sam3VideoModel` (video, **concept**) — text only
- `Sam3TrackerModel` (image, **drop-in SAM 2 replacement**) — points + boxes + masks
- `Sam3TrackerVideoModel` (video, **drop-in SAM 2 replacement**) — points + boxes at frames

| Surface | Prompt | Endpoint | Backing class |
|---|---|---|---|
| Image | Click points (positive=1, negative=0) | `/sam/decode` | `Sam3TrackerModel` |
| Image | Text concept | `/sam/text-prompt` | `Sam3Model` |
| Image | Boxes (positive=1, negative=0, optionally + text) | `/sam/box-prompt` | `Sam3Model` |
| Video | Click points (positive=1, negative=0) at frame 0 | `/sam-track/start` with `points`+`labels` | `Sam3TrackerVideoModel` |
| Video | Text concept tracking | `/sam-track/start` with `text` | `Sam3VideoModel` |

**Earlier docs (v1.2.2) incorrectly stated SAM 3 video point prompts were
not exposed by HF transformers — that was wrong.**
`Sam3TrackerVideoProcessor.add_inputs_to_inference_session(...)` provides
full point/box prompt support. v1.3.0 wires this correctly via the
`Sam3VideoDispatcherAdapter`, which holds both the Tracker pair and the
Concept pair and dispatches based on prompt type at the first
`add_new_points` call.

License + weights: AGPL-3.0 / Enterprise. Same model weights
(`facebook/sam3`) for all four classes — no extra downloads.

#### Implementation notes per endpoint

- **Image clicks** (`/sam/encode` + `/sam/decode`): wire-compatible with
  SAM 2. Click points are routed into `Sam3TrackerModel` (the drop-in
  SAM 2 replacement) with positive=1 / negative=0 labels. The model
  returns K=3 multimask candidates per object; the router picks the
  highest-scoring mask via `np.argmax(scores)`. The container loads
  `transformers.Sam3TrackerModel` + `Sam3TrackerProcessor` lazily on
  first request via `carve_model.sam.sam3_adapter.build_sam3_image_predictor`.
- **Text prompts** (`/sam/text-prompt`): functional. Uses `Sam3Model` +
  `Sam3Processor` (concept). The text predictor is registered
  automatically by the SAM 3 image factory the first time `/sam/encode`
  runs. Returns one segmentation per matching object instance.
- **Box prompts** (`/sam/box-prompt`, v1.2.2): one-shot endpoint.
  Uses `Sam3Model` + `Sam3Processor`. Accepts
  `{image_b64, boxes, box_labels, text?}`. Boxes are xyxy floats;
  `box_labels` are 1 (positive) or 0 (negative). Combining `text` with
  a negative box refines a concept by excluding a region. Returns 409
  `box_prompt_not_supported_for_variant` when the active variant does
  not expose box prompting (e.g. any sam2.x variant). The gate is
  capability-based — any variant whose adapter advertises
  `supports_box` will satisfy this route.
- **Video tracking** (`/sam-track/start`): accepts EITHER `points` +
  `labels` (numeric clicks → `Sam3TrackerVideoModel.add_inputs_to_inference_session`)
  OR `text` (concept → `Sam3VideoModel.add_text_prompt`). When neither
  is supplied, the endpoint returns `422 sam3_track_requires_points_or_text`.
  Example bodies:
  ```json
  POST /sam-track/start
  {"video_url": "https://.../v.mp4", "text": "person"}
  ```
  ```json
  POST /sam-track/start
  {"video_url": "https://.../v.mp4", "points": [[210, 350]], "labels": [1]}
  ```
  The `/{session}/step` endpoint is unchanged; it returns the
  highest-scoring object's mask per frame (multi-object output is a
  v1.4 enhancement).

### Notes

- SAM 3 is roughly 860M parameters; it needs more VRAM than
  SAM 2.1 Large. The 4070 (16 GB) handles it in bf16 with `SAM_BF16=1`
  (the default).
- SAM 3 (~12 GB at bf16) and YOLO weights are loaded independently. They
  do **not** evict each other automatically. If your GPU has limited VRAM,
  either lower `SAM_IDLE_TIMEOUT_S` so SAM frees memory between uses, or
  run YOLO and SAM in separate inference containers behind a load balancer.
- Switch back to SAM 2 with `SAM_MODEL=sam2.1-large` (or any other size)
  and restart the container — the configured model is read at first
  predictor load, so a restart is required.

### Supported YOLO weight versions

The model service uses Ultralytics' unified `YOLO()` loader, which
auto-detects the architecture from the `.pt` file's metadata. The
loader is version-agnostic — `apps/model/src/carve_model/yolo/registry.py`
contains no architecture-specific logic.

Currently pinned: `ultralytics==8.4.41` (PyPI). This release supports:

- **YOLOv5 / YOLOv8** (legacy detect/seg/cls/pose/OBB)
- **YOLO11** (recommended for general use; Sep 2024)
- **YOLO26** (Jan 14, 2026 — the current state-of-the-art)

#### YOLO26 variant matrix

| Task | n | s | m | l | x |
|---|---|---|---|---|---|
| Detection | yolo26n.pt | yolo26s.pt | yolo26m.pt | yolo26l.pt | yolo26x.pt |
| Segmentation | yolo26n-seg.pt | yolo26s-seg.pt | yolo26m-seg.pt | yolo26l-seg.pt | yolo26x-seg.pt |
| Classification | yolo26n-cls.pt | yolo26s-cls.pt | yolo26m-cls.pt | yolo26l-cls.pt | yolo26x-cls.pt |
| Pose | yolo26n-pose.pt | yolo26s-pose.pt | yolo26m-pose.pt | yolo26l-pose.pt | yolo26x-pose.pt |
| OBB | yolo26n-obb.pt | yolo26s-obb.pt | yolo26m-obb.pt | yolo26l-obb.pt | yolo26x-obb.pt |

Param counts (approximate):
- nano (n): 2.4–2.9M params
- small (s): 9.5–10.4M params
- medium (m): 20.4–23.6M params
- large (l): 24.8–28.0M params
- xlarge (x): 55.7–62.8M params

#### Editor compatibility today

The editor's task kinds (`detect`, `segment`, `classify`) work with
YOLO26 detection, segmentation, and classification weights without any
code change. **Pose and OBB weights load** via the registry (the test
suite proves it) but the editor's annotation UI does not yet draw or
store keypoints / oriented boxes — those are the v2 deferred items.
Operators uploading YOLO26 pose/OBB weights today should expect the
weight to be cached but unused by the auto-annotation pipeline.

#### Bumping for newer releases

To support a release post-YOLO26 (e.g., YOLO27), edit
`apps/model/pyproject.toml`:

```toml
"ultralytics==<NEW_VERSION>",
```

Then rebuild only the inference-profile container:

```bash
docker compose build model && docker compose --profile inference up -d model
```

The editor stack does not need to restart.

#### License

YOLO26 is dual-licensed: AGPL-3.0 (open source) and Enterprise. The same
licensing applies to other Ultralytics YOLO releases. AGPL-3.0 imposes
copyleft requirements on derivatives — verify with your legal team
before integrating into a closed-source product.

### Independence from YOLO

SAM and YOLO are independent registries. Specifically:
- The web editor's manual tools (bbox / polygon / mask brush / tag) make no calls to the model service. The editor works with the `model` container stopped.
- SAM is loaded lazily on the first `/sam/encode` call and unloaded after `SAM_IDLE_TIMEOUT_S` of inactivity.
- YOLO weights are loaded lazily on the first `/yolo/load` call. The LRU registry holds at most `capacity` weights (default 2); a new `load` call evicts the least-recently-used weight when full.
- Loading or unloading one does not affect the other. Plan your VRAM accordingly.

## In-browser SAM decoder (WebGPU) — admin setup

The browser can run the SAM 2 decoder locally via WebGPU + ONNX Runtime
Web, eliminating the round-trip per click.

1. Download the SAM 2 decoder ONNX model from upstream (Meta SAM 2 repo or
   a maintained mirror) and place it at:

   ```
   apps/web/public/models/sam2_decoder.onnx
   ```

2. Rebuild the web container:

   ```bash
   docker compose build web && docker compose up -d web
   ```

3. Open the editor in a Chrome-based browser with WebGPU support. The SAM
   tool will automatically detect the model file and use local decoding.

If the model file is absent or the browser lacks WebGPU, the editor falls
back to the existing server-side `/sam/decode` endpoint with no
functionality loss.

The api caches encoded image embeddings in Redis with a 30-minute TTL, so
repeated SAM activations on the same image are near-instant.

## Rate limits

The API enforces the following default rate limits:

| Endpoint | Limit |
|---|---|
| `POST /auth/login` | 10 requests / minute |
| `POST /auth/register` | 5 requests / minute |
| `POST /weights` (YOLO upload) | 30 requests / minute |
| `POST /assets` (asset upload) | 100 requests / minute |
