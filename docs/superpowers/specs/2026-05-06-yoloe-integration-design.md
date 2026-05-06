# YOLOE — Real-Time Seeing Anything: Integration Design

**Date:** 2026-05-06
**Author:** Armin Mehri
**Version:** v3.23 (planned)
**Status:** Awaiting sign-off

---

## 1. Goal

Add YOLOE (Ultralytics "Real-Time Seeing Anything") as a first-class
auto-annotation engine in Carve, available alongside the existing
YOLO and SAM 3 paths. YOLOE delivers **open-vocabulary detection +
instance segmentation** with three prompting modes and works on both
images and videos. The integration must:

1. Expose all three YOLOE prompting modes (text, visual, prompt-free).
2. Cover both **current asset** and **all assets in task** scopes.
3. Cover both **image** and **video** assets (videos via existing per-frame extraction).
4. Mirror existing patterns: model-service router → API service → batch RQ worker → React dialog with polling and `useBackgroundJobs` integration.
5. Ship with a polished, modern dialog (single panel, three tabs) — not generic toolbar buttons.

The two checkpoints used:

| Mode | Checkpoint | Notes |
|---|---|---|
| Text + Visual prompts | `yoloe-26l-seg.pt` (32.3M params, LVIS mAP 36.8) | `model.set_classes(...)` for text, `predictor=YOLOEVPSegPredictor` for visual |
| Prompt-Free | `yoloe-26l-seg-pf.pt` | 1200+ vocabulary from LVIS + Objects365 |

---

## 2. The three modes — what they do

### 2.1 Text Prompt
User types a comma-separated list of class names (e.g. `person, bus, traffic light`). YOLOE returns boxes + masks for each named class.

```python
model = YOLOE("yoloe-26l-seg.pt")
model.set_classes(["person", "bus"])
results = model.predict(image, conf=0.25, iou=0.7)
```

### 2.2 Visual Prompt
User selects a **reference image + bbox(es)** that show what the object looks like; YOLOE finds visually similar objects in the target image(s).

```python
visual_prompts = dict(
    bboxes=np.array([[221.5, 405.8, 344.9, 857.5]]),
    cls=np.array([0]),
)
model.predict(target, refer_image=ref, visual_prompts=visual_prompts,
              predictor=YOLOEVPSegPredictor)
```

### 2.3 Prompt-Free
No prompts. The PF checkpoint detects everything in its 1200-class vocabulary. Output names are pulled from the model's internal embedding lookup.

```python
model = YOLOE("yoloe-26l-seg-pf.pt")
results = model.predict(image)
```

### Output shape
All three modes return Ultralytics `Results` with `.boxes`, `.masks` (xy polygons), `.names`, `.cls`, `.conf`. We coerce to the same `{detections, polygons}` shape the existing YOLO predict path uses, so downstream class-mapping logic is reused unchanged.

### Video handling
For both images and videos we keep the existing pattern: videos are pre-extracted to per-frame JPEGs (already supported via `FrameExtractDialog`); YOLOE runs on the frame the editor is showing. For "all assets" mode, the worker iterates assets and either reads the image bytes or — for videos — runs against the first frame only (matching the YOLO batch path) unless the user explicitly opted into per-frame.

---

## 3. Architecture — three layers

### 3.1 Model service (`apps/model/src/carve_model/yoloe/`)

New package. Files:

- `__init__.py` — package marker
- `predict.py` — three predict functions: `predict_text`, `predict_visual`, `predict_prompt_free`. Each accepts `image_bytes`, runs Ultralytics, returns `{detections: [...], polygons: [...]}`.
- `registry.py` — pre-loaded singleton holders for both checkpoints. YOLOE weights are bundled with the image (download on first use via Ultralytics auto-download or `YOLOE_WEIGHTS_DIR` env). Lazy-load on first call; LRU-evict after `_YOLOE_IDLE_TIMEOUT_S` (mirrors SAM predictor sweeper).
- `router.py` — three FastAPI endpoints:
  - `POST /yoloe/text-predict` — body: `{image_b64, classes: [str], conf, iou}`
  - `POST /yoloe/visual-predict` — body: `{target_b64, refer_b64, bboxes, cls, conf, iou}` (refer_b64 may equal target_b64 for "use this same image as reference")
  - `POST /yoloe/prompt-free-predict` — body: `{image_b64, conf, iou, max_detections?}`
- `GET /yoloe/status` — capability probe: `{available: bool, text_loaded, pf_loaded, device}`. Mirrors `/sam/status`.

Lifespan registration in `apps/model/src/carve_model/main.py`: include router, add to `/capabilities` models list. Pre-warm is optional via `YOLOE_PREWARM=1`.

### 3.2 API service (`apps/api/src/carve_api/inference/`)

New file `yoloe.py` containing:

- HTTP client wrappers added to `model_client.py`: `yoloe_text_predict`, `yoloe_visual_predict`, `yoloe_prompt_free_predict`, `yoloe_status`. Same `_wrap_unreachable` + `ModelServiceError` pattern as existing helpers.
- Service-layer functions: `yoloe_for_asset(asset, mode, params, *, frame_id=None)` — fetches image bytes (image asset or per-frame JPEG for video), calls model service, returns the same shape as YOLO so the persistence path can be reused.
- `apply_yoloe_to_asset(session, actor, task, asset, mode, params, *, overwrite, min_confidence, class_overrides)` — maps YOLOE outputs → project `Class` rows (text mode: case-insensitive name match against the project's classes, with optional per-class override; PF mode: same; visual mode: the user picks one project class up front so all detections inherit it).

New endpoints in `inference/router.py`:

| Verb | Path | Purpose |
|---|---|---|
| `GET` | `/inference/yoloe/status` | Capability probe (frontend gates UI on this) |
| `POST` | `/assets/{asset_id}/yoloe/text` | Sync, current asset, text mode |
| `POST` | `/assets/{asset_id}/yoloe/visual` | Sync, current asset, visual mode |
| `POST` | `/assets/{asset_id}/yoloe/prompt-free` | Sync, current asset, PF mode |
| `POST` | `/tasks/{task_id}/yoloe/batch` | Async (RQ), all assets, any mode (mode in body) |
| `GET` | `/tasks/{task_id}/yoloe/batch/{job_id}` | Polling progress (reuses `BatchAutoAnnotateProgress` schema) |
| `POST` | `/tasks/{task_id}/yoloe/batch/{job_id}/cancel` | Cooperative cancel (status=canceled + `send_stop_job_command`) |

Batch worker `run_yoloe_batch(payload: YoloeBatchPayload)` in `inference/batch.py`:
- One shared session, per-asset commit (same v3.7.6 contract as YOLO batch).
- Pre-validates the model service has YOLOE loaded (calls `yoloe_status`); fails fast with a clear error if not.
- Cooperative cancel between assets via Redis `status` flag; v3.22.1 stop-command for in-flight HTTP latency.
- Reuses `progress_key`, `init_progress`, `update_progress`, `finalize_progress`, `read_progress`.

Permissions: same `_MUTATING_ROLES` guard as auto-annotate; sync endpoints require `require_visible_task`.

### 3.3 Frontend (`apps/web/src`)

#### New API client `apps/web/src/api/yoloe.ts`
Typed wrapper exposing `yoloeApi`:
- `status()` → `{ available, text_loaded, pf_loaded, device }`
- `textPredict(assetId, body)`, `visualPredict(assetId, body)`, `promptFreePredict(assetId, body)`
- `enqueueBatch(taskId, body)`, `pollBatch(taskId, jobId)`, `cancelBatch(taskId, jobId)`

#### New dialog `apps/web/src/components/annotation/YoloeDialog.tsx`
A single, polished dialog with:

- **Header**: "YOLOE — Real-Time Seeing Anything" + subtitle.
- **Mode tabs** (three pills, large, with icons): **Text Prompt** (`Type` icon), **Visual Prompt** (`MousePointerSquareDashed` icon), **Prompt-Free** (`Sparkles` icon).
- **Tab body** changes per mode:
  - *Text*: a chip-style multi-input ("Add class…"). Suggestions from the project's existing classes when typing. Min 1 class.
  - *Visual*: a reference-image picker (defaults to the current asset; "Use a different reference" opens an asset thumbnail strip). Below, the user draws one or more bboxes on the chosen reference (re-uses the canvas's draw layer; if the dialog can't host a draw layer, fallback is "Pick a bbox from existing annotations on this asset" — which we already have). Plus a single "Annotate as → [project class dropdown]" so detected matches all map to one class.
  - *Prompt-Free*: a max-detections cap (default 100) and a min-confidence slider. The user picks one project class for "annotate everything as", OR opts into "use detected names → name-match against project classes" which mirrors the YOLO batch class-mapping behavior.
- **Common controls** (always visible below the tab body):
  - Scope: `[ This image ]  [ All assets in task ]` (radio, large pills).
  - Confidence threshold slider (default 0.25, range 0–1).
  - IoU/NMS slider (default 0.7).
  - Overwrite existing toggle.
- **Footer**: Cancel / Run primary CTA. While running: progress bar with done/total, Cancel and Background buttons (reuses the same shape as `BatchProgressView` in `AutoAnnotateDialog`).
- **Capability gating**: if `yoloeApi.status().available === false`, the dialog renders a clear "YOLOE is not available on this server" state with a hint to enable the model service. The toolbar button is hidden/disabled in that case (mirrors the SAM/FO1 pattern).

#### EditorToolbar entry
Add a new button next to the existing "Auto" (Sparkles) button: **YOLOE** with the `ScanEye` icon. Styled like the existing toolbar pills. Clicking opens `YoloeDialog`. When YOLOE is unavailable per `/inference/yoloe/status`, the button hides (stays consistent with how `AutoAnnotateDialog` handles SAM 3).

#### Background jobs
Add a new kind: `"yoloe-batch"` to `BackgroundJobKind`. Add it to `EXPANDABLE_KINDS` and the bar's poll dispatcher (`inferenceApi.pollYoloeBatch`). On Background click in the dialog, register the running job via `useBackgroundJobs.add({...})` exactly like the YOLO batch overlay does, then close the dialog.

#### Visual quality (anti-template)
Per `web/design-quality.md` we deliberately avoid generic shadcn-card layouts:
- Mode tabs are chunky pills with subtle hover lift, not stock tab-trigger styling.
- Class-chip input has the same chip aesthetic as `ClassesPanel`.
- Capability/error states use the existing `SamUnavailableBanner` design language so it feels native to Carve.
- Progress bar uses the same determinate animation token (`batch-predict-bar-determinate`) so it matches the YOLO batch overlay.

---

## 4. Data flow

**Sync, current asset, text mode** (example — others mirror this):

1. UI: user types classes, clicks Run.
2. `yoloeApi.textPredict(assetId, body)`.
3. API: `inference/yoloe.yoloe_for_asset(asset, mode="text", params)` →
4. `model_client.yoloe_text_predict(image_b64, classes, conf, iou)` →
5. Model service: `yoloe/router.text_predict` → `predict_text` → returns `{detections, polygons}`.
6. API: persists annotations via the existing `auto_annotate_asset` adapter (re-shaped input), commits, returns `AutoAnnotateResponse`.
7. UI: invalidates annotation queries; toast "Created N annotations · skipped M".

**Async, all assets, any mode**: identical except step 2 enqueues an RQ job and the UI polls; cancel + Background work via `useBackgroundJobs`.

---

## 5. DB / migration considerations

- **No new tables.** Annotations land in the existing `annotations` table via the same persistence path as YOLO.
- **No `Weight` row** is created for YOLOE — the checkpoints live on the model service container, not in MinIO. They're not user-uploadable. A new `weight_task_kind` value is **not** introduced.
- **Per-user pref (optional, deferred)**: a `users.yoloe_default_mode` text column could remember last-used tab. Not in v3.23 — start without it; the dialog defaults to Text mode every open.

---

## 6. Settings, env, ops

| Env | Default | Purpose |
|---|---|---|
| `YOLOE_AVAILABLE` | `0` | Operator opt-in (mirrors `VLM_FO1_AVAILABLE`) |
| `YOLOE_WEIGHTS_DIR` | `/app/weights/yoloe` | Where the .pt files live |
| `YOLOE_PREWARM` | `0` | Pre-load both checkpoints at lifespan start |
| `YOLOE_IDLE_TIMEOUT_S` | `900` | Idle-evict the model after 15min of inactivity |

Docker-compose: bundle the two `.pt` files via build-time download in the `model` Dockerfile, or mount them via a volume. Default: build-time `RUN ultralytics pull yoloe-26l-seg.pt yoloe-26l-seg-pf.pt`.

---

## 7. Error handling

| Failure | API status | UI |
|---|---|---|
| Model service unreachable | 503 `model_service_unreachable` | Inline banner: "Model service is offline" |
| YOLOE not enabled (no checkpoints) | 409 `yoloe_not_available` | Hide entry; if dialog opens, show capability state |
| Invalid prompt (empty class list, etc.) | 422 | Inline form error |
| Cancel during sync run | 499 (or 200 with `canceled` flag) | Toast "Canceled — kept N annotations" |
| Per-asset failure in batch | counted in `failed`, error msg in `errors[]` | Same as YOLO batch toast |

---

## 8. Testing

- **Model service**: `apps/model/tests/yoloe/` with stubbed `YOLOE` class. Unit-test each predict function with a mocked Ultralytics result. Coverage ≥80%.
- **API service**: `apps/api/tests/inference/test_yoloe_*.py` with `httpx.MockTransport` against the model service. Test sync endpoints, batch enqueue, cooperative cancel, capability status.
- **Frontend**: `apps/web/src/components/annotation/__tests__/YoloeDialog.test.tsx` with mocked `yoloeApi`. Test mode switching, scope toggle, capability gating, Background/Cancel handshakes.
- **E2E (deferred)**: `tests/e2e/yoloe.spec.ts` skip-if-`YOLOE_AVAILABLE=0`. Out of scope for v3.23 unless capacity allows.

---

## 9. Out of scope (this iteration)

- Fine-tuning / training UI (text/visual prompt-only models support training but we're inference-only here).
- ONNX / TensorRT export.
- YOLOE for `sam-track` (would require visual prompt → tracking handoff). Future work.
- Per-asset visual-prompt drawing **inside the dialog**. v1 ships with "use this asset as reference" + the existing canvas tool; an in-dialog draw layer is a separate visual upgrade.

---

## 10. Implementation order

1. Model service: package + adapter + router + lifespan + tests.
2. API service: model_client wrappers + inference/yoloe.py + router endpoints + batch worker + tests.
3. Frontend: api/yoloe.ts + YoloeDialog.tsx + EditorToolbar entry + backgroundJobs kind + BackgroundJobsBar dispatcher.
4. Smoke test in browser (one image, one video, all three modes, both scopes).
5. Commit + push.

Each layer commits independently so a failure mid-implementation doesn't poison the tree.
