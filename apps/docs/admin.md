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

### What SAM 3 changes

- **Image clicks** (`/sam/encode` + `/sam/decode`): same wire API as
  SAM 2. Click points are routed into `Sam3Model` with positive=1 /
  negative=0 labels. The container loads `transformers.Sam3Model` and
  `Sam3Processor` lazily on first request via the SAM 3 image adapter
  (`vaa_model.sam.sam3_adapter.build_sam3_image_predictor`).
- **Text prompts** (`/sam/text-prompt`): now functional. The text
  predictor is registered automatically by the SAM 3 image factory the
  first time `/sam/encode` runs, so no manual
  `set_text_predictor(...)` call is required. Returns one segmentation
  per matching object instance.
- **Video tracking** (`/sam-track/start`): now requires a `text` field.
  Existing `points` / `labels` fields are ignored (the endpoint returns
  `422 sam3_track_requires_text` if `text` is missing or empty). Example:
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
- Loading SAM 3 evicts the YOLO LRU cache. Operators with frequent YOLO
  use should consider a separate inference container.
- Switch back to SAM 2 with `SAM_MODEL=sam2.1-large` (or any other size)
  and restart the container — the configured model is read at first
  predictor load, so a restart is required.

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
