# Admin & operations

## User management

The first visit to the app triggers the **First-run admin wizard**, which creates the bootstrap admin account. After that:

- Public self-registration is disabled.
- Admins can create new accounts at `/auth/register` (admin-only route).
- User roles: **admin** (full access) and **annotator** (project-scoped access).

## Backups

A backup script is provided at `scripts/backup.sh`. It dumps Postgres and snapshots the MinIO bucket to a local archive directory.

Recommended cron (daily at 03:00):

```cron
0 3 * * * /path/to/repo/scripts/backup.sh >> /var/log/vaa-backup.log 2>&1
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
- **GPU memory management:** SAM models are unloaded from GPU memory
  after `SAM_IDLE_TIMEOUT_S` seconds of inactivity (default `900` =
  15 min). Set to `0` to disable idle eviction. Force-unload immediately
  via `POST /sam/unload` (admin endpoint inside the model service network;
  not proxied through Caddy). The body accepts
  `{"which": "image" | "tracker" | "all"}` (default `"all"`); the
  response lists what was actually freed.

When SAM 3 is **disabled** (any non-`sam3` value, default `sam2.1-large`),
the `POST /sam/text-prompt` endpoint returns `409 sam3_not_enabled`. The
rest of the SAM 2 surface (`/sam/encode`, `/sam/decode`, sam-track) is
unaffected.

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

### SAM 3 prompt support — what works today

The SAM 3 integration uses HuggingFace `transformers` v5.6.x, which exposes
the following prompt modes:

| Surface | Prompt | Endpoint | Status |
|---|---|---|---|
| Image | Click points (positive=1, negative=0) | `/sam/decode` | Works (same API as SAM 2) |
| Image | Text concept | `/sam/text-prompt` | Works |
| Image | Boxes (positive=1, negative=0) | `/sam/box-prompt` | Works (v1.2.2) |
| Image | Combined text + negative box (refine concept) | `/sam/box-prompt` with `text` field | Works (v1.2.2) |
| Video | Text concept tracking | `/sam-track/start` with `text` field | Works |
| Video | Mask refinement | (not exposed in editor UI) | Underlying `Sam3VideoInferenceSession.add_mask_inputs` |
| Video | Click points or boxes | — | **Not exposed** in `transformers` v5.6.2 public API |

**About SAM 3 video point/box prompts:** The SAM 3 architecture includes a
SAM 2-style tracker module that supports point/box prompts at the model
level. However, `transformers v5.6.2` does not expose any public method on
`Sam3VideoProcessor` or `Sam3VideoInferenceSession` to add point or box
prompts at a frame — `point_inputs_per_obj` is initialized in the session
but never populated or read in this version. We will wire point-based
SAM 3 video tracking when HuggingFace exposes the API (likely in a
future minor release). For point-based video tracking today, set
`SAM_MODEL=sam2.1-large` (or any SAM 2.1 size) — SAM 2 supports full
point/box/mask prompting on video.

#### Implementation notes per endpoint

- **Image clicks** (`/sam/encode` + `/sam/decode`): same wire API as
  SAM 2. Click points are routed into `Sam3Model` with positive=1 /
  negative=0 labels. The container loads `transformers.Sam3Model` and
  `Sam3Processor` lazily on first request via the SAM 3 image adapter
  (`vaa_model.sam.sam3_adapter.build_sam3_image_predictor`).
- **Text prompts** (`/sam/text-prompt`): functional. The text predictor
  is registered automatically by the SAM 3 image factory the first time
  `/sam/encode` runs, so no manual `set_text_predictor(...)` call is
  required. Returns one segmentation per matching object instance.
- **Box prompts** (`/sam/box-prompt`, v1.2.2): one-shot endpoint.
  Accepts `{image_b64, boxes, box_labels, text?}`. Boxes are xyxy
  floats; `box_labels` are 1 (positive) or 0 (negative). Combining
  `text` with a negative box refines a concept by excluding a region
  (`Sam3Processor` supports text + `input_boxes_labels=[[0]]` natively).
  The box predictor is registered alongside the text predictor on first
  `/sam/encode`. Returns 409 `sam3_box_prompt_requires_sam3` when SAM 3
  is not the active model.
- **Video tracking** (`/sam-track/start`): SAM 3 requires a `text`
  field. Existing `points` / `labels` fields are ignored (the endpoint
  returns `422 sam3_track_requires_text` if `text` is missing or empty).
  Example:
  ```json
  POST /sam-track/start
  {"video_url": "https://.../v.mp4", "text": "person"}
  ```
  → tracks every person in the video. The `/{session}/step` endpoint is
  unchanged; it returns the highest-scoring object's mask per frame
  (multi-object output is a future enhancement).

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
loader is version-agnostic — `apps/model/src/vaa_model/yolo/registry.py`
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
