# Plan 11 — Phase 6: SAM 3.1 Migration + Object Multiplex Multi-Object Tracking + Inference Optimisation

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development.

**Goal:** replace SAM 3 with SAM 3.1 for image (point/box/text) and video (multi-object multi-class point/box) workflows, using the native `sam3` git package's **Object Multiplex** for joint multi-object tracking. Apply maximum hardware-appropriate inference optimisation for RTX 3090 / 4070 Ti class GPUs (Ampere/Ada): **bfloat16** + **SDPA** + opt-in **FlashAttention 2** + `torch.compile`.

## Hardware reality check

- **FlashAttention 4** requires Hopper (H100/H200) or Blackwell (GB200). RTX 3090 / 4070 Ti are Ampere / Ada — explicitly **NOT supported** per the [PyTorch FlexAttention + FA4 blog](https://pytorch.org/blog/flexattention-flashattention-4-fast-and-flexible/).
- **FlashAttention 2** is supported on the user's GPUs but requires the heavy `flash-attn` package (long compile, large CUDA dep).
- **SDPA** (PyTorch's `scaled_dot_product_attention`) is built into PyTorch ≥ 2.0, supports Ampere/Ada, and gives most of FA2's gain with zero install. **This is the default we'll ship.**
- **`torch.compile`** with the `mode="reduce-overhead"` setting yields significant additional throughput on the SAM image encoder at no inference-quality cost.

## Architecture

- **Image** path stays on **HuggingFace transformers** with `facebook/sam3` (text/box/point) — already wired in our codebase. We migrate this to `bfloat16` + `attn_implementation="sdpa"` + optional `torch.compile`.
- **Video** path is rewritten to use the **native `sam3` git package** (`pip install 'git+https://github.com/facebookresearch/sam3.git'`) and its `build_sam3_multiplex_video_predictor()` factory. This is the only way to get SAM 3.1's Object Multiplex (~7× speedup at 128 objects, joint multi-object tracking).
- The native predictor exposes a request/stream API (`handle_request(start_session)`, `add_prompt(text|points|box, obj_id)`, `propagate_in_video` streaming generator, `remove_object`, `reset_session`). Our `TrackerProtocol` adapter wraps it.
- Backwards compatibility: the existing transformers-based `Sam3VideoDispatcherAdapter` stays as a fallback when `SAM_VIDEO_BACKEND=transformers` (env). Default is `multiplex` once SAM 3.1 is wired.

## Out of scope

- FlashAttention 4 (hardware unsupported on the user's GPUs).
- New training/finetuning — inference-only.
- Browser-side WebGPU SAM 3.1 (the existing onnxruntime-web local decoder isn't touched).

---

## Series context

- ✅ Plans 01–08 shipped
- ✅ v3.9.0 — Plan 09 / Phase 5
- ✅ v3.9.1 — Plan 09b / Phase 5 deferrals
- ⏸ v3.8 Phase 4 video-tracking — superseded by this plan
- **Plan 11 — Phase 6: SAM 3.1** ← *this plan*

---

## Track A — Native sam3 install + image-side optimisation

### Task 1: Install native `sam3` git package + verify image path

**Files:**
- modify `apps/model/pyproject.toml` (add `sam3 @ git+https://github.com/facebookresearch/sam3.git` to `[project.optional-dependencies] gpu` *only if* it doesn't conflict with the existing transformers extras; otherwise as a separate `sam3` extra and document the install order)
- modify `apps/model/Dockerfile` if needed (extra apt deps for the build)
- new `apps/model/tests/sam/test_sam3p1_install.py` — a tiny smoke test that `from sam3.model_builder import build_sam3_multiplex_video_predictor` imports without error (skip when env `SAM3P1_AVAILABLE=0`).

**Spec:**
- The package may install several GB of weights and require `git`/`gcc` already present. Verify the existing image has them.
- Do NOT load the predictor at import time — only verify the import is available.
- Document a fallback in the plan: if the install can't land in this run, every later task gates on `try: import sam3` and falls back to the existing transformers code paths.

### Task 2: Image predictor — bf16 + SDPA + compile

**Files:**
- modify `apps/model/src/carve_model/sam/sam3_adapter.py` (`Sam3ImagePredictorAdapter`, `_predict_from_text`, `_predict_from_boxes`)
- modify `apps/model/src/carve_model/sam/predictor.py` (config knobs: `_sam_dtype()`, `_sam_attn_impl()`, `_sam_compile()`)
- new `apps/model/src/carve_model/sam/perf.py` — small module exposing `get_dtype()`, `get_attn_impl()`, `apply_compile_to_image_encoder(model)`.
- new `apps/model/tests/sam/test_perf.py`

**Spec:**
- Config:
  - `SAM_DTYPE` env var: one of `bf16`, `fp16`, `fp32` (default `bf16` on cuda, `fp32` on cpu).
  - `SAM_ATTN_IMPL` env var: one of `sdpa`, `flash_attention_2`, `eager` (default `sdpa`).
  - `SAM_COMPILE` env var: `true` / `false` (default `false`; user opts in once verified stable).
- All `from_pretrained(...)` calls in `sam3_adapter.py` thread `dtype=get_dtype()` and `attn_implementation=get_attn_impl()`. Document each change with a comment.
- When `SAM_COMPILE=true`, `apply_compile_to_image_encoder(model)` wraps the vision encoder with `torch.compile(mode="reduce-overhead", fullgraph=False)`. Wrap only the image encoder, not the full model — the predictor's mask-decoder loop has dynamic shapes that don't compile cleanly.
- bf16 → numpy cast: ensure all tensors hitting `.numpy()` are converted to `float32` first (we already have a few of these patches; consolidate them to a `_to_numpy_safe(t)` helper in `perf.py`).
- If `flash_attention_2` is requested but `flash_attn` isn't installed, log a warning and silently fall back to `sdpa` (don't crash).

**Tests:**
- `get_dtype()` returns `torch.bfloat16` when env `SAM_DTYPE=bf16`, `torch.float32` otherwise.
- `get_attn_impl()` falls back to `sdpa` when `flash_attention_2` is requested but `flash_attn` is absent.
- `_to_numpy_safe(bf16_tensor).dtype == np.float32`.

---

## Track B — Native multiplex video adapter

### Task 3: New `Sam3p1MultiplexVideoAdapter` (TrackerProtocol implementation)

**Files:**
- new `apps/model/src/carve_model/sam/sam3p1_adapter.py`
- modify `apps/model/src/carve_model/sam/tracker.py` (`_default_factory` routes `SAM_MODEL=sam3.1` or `SAM_VIDEO_BACKEND=multiplex` to the new adapter)
- new `apps/model/tests/sam/test_sam3p1_adapter.py`

**Spec:**
- The adapter satisfies the existing `TrackerProtocol` interface so the rest of the codebase (track_router, sam_track API, frontend) needs minimal changes:
  - `init_state(video_path) -> Any` — opens a session via the native predictor's `handle_request({"type": "start_session", "resource_path": video_path})`. Returns the session_id wrapped in our state dict.
  - `add_inputs_at_frame(state, frame_idx, obj_id, points=None, labels=None, boxes=None) -> Any` — calls `handle_request({"type": "add_prompt", session_id=..., frame_index=frame_idx, obj_id=obj_id, points=tensor or None, point_labels=tensor or None, box=tensor or None})`. The native API uses **relative coords** in `[0, 1]` for points and boxes; our codebase passes **absolute pixel coords**. The adapter MUST convert via the session's known image size (returned in start_session response or queried separately).
  - `add_text_prompt(state, frame_idx, text)` — calls `add_prompt` with `text=text` (no obj_id; multiplex auto-assigns obj ids per detected instance).
  - `propagate_in_video(state) -> Iterator[(frame_idx, dict[obj_id, mask])]` — wraps `handle_stream_request({"type": "propagate_in_video", session_id=...})`. The native generator yields `{frame_index, outputs: {<obj_id>: {mask, score, bbox, ...}}}`. Translate to our existing `(frame_idx, dict[int, np.ndarray])` shape.
  - `remove_object(state, obj_id)` — `handle_request({"type": "remove_object", session_id=..., obj_id=obj_id})`. Used by the frontend "delete this tracked object" affordance.
  - `reset_session(state)` — `handle_request({"type": "reset_session", session_id=...})`. Used when switching from a text prompt to a different text prompt mid-session.
- Build via `build_sam3_multiplex_video_predictor(device=...)`. Cache the predictor at module level (it's heavy).
- Apply bf16 dtype + SDPA attention via the same `perf.py` helpers from Task 2.

**Tests:**
- Adapter implements all `TrackerProtocol` methods.
- A stub native predictor returns mock session id + mock streaming output; adapter's `propagate_in_video` translates the dict shape correctly.
- Coord conversion: a click at (300, 200) on a 1920×1080 image → relative `(0.156, 0.185)`.
- Box conversion: xyxy `(100, 50, 500, 400)` → relative `(0.052, 0.046, 0.260, 0.370)`.
- `text` and `points` cannot both be set on the same `add_prompt` call (raises).

### Task 4: Track router — use multiplex semantics when active

**Files:**
- modify `apps/model/src/carve_model/sam/track_router.py`
- modify `apps/model/src/carve_model/sam/tracker.py` (session metadata: track which adapter is in use; expose `remove_object` on the existing `add_object_to_session`/`remove_object_from_session` helpers)
- modify `apps/api/src/carve_api/inference/sam_track.py` (add a `remove_object(session_id, obj_id)` proxy)
- modify `apps/api/src/carve_api/inference/router.py` (new endpoint `DELETE /assets/{aid}/sam-track/{sid}/objects/{oid}`)
- modify `apps/api/src/carve_api/inference/model_client.py` (`sam_track_remove_object`)
- new tests:
  - `apps/model/tests/sam/test_multiplex_track_router.py`
  - `apps/api/tests/inference/test_sam_track_multiplex.py`

**Spec:**
- The new endpoint surface is additive — don't break the existing `/sam-track/start`, `/sam-track/{sid}/objects`, `/sam-track/{sid}/step`, `DELETE /sam-track/{sid}` routes.
- `POST /sam-track/{sid}/objects` body now also accepts `text: string | null` for SAM 3.1 text-driven multi-object detection on a specific frame. When `text` is provided, the multiplex predictor returns a set of detected obj_ids; the response shape extends to `{obj_ids: int[]}` instead of just `{obj_id, frame_idx}`.
- `POST /sam-track/{sid}/step?frames=N` returns the same shape but each frame's `objects` array now carries every multiplex-tracked object joined.
- New `DELETE /sam-track/{sid}/objects/{oid}` removes an object from an in-flight session. 204 on success, 404 if obj_id unknown.

---

## Track C — Frontend updates

### Task 5: TrackPropagateTool + SamTrackPanel — multi-object multiplex affordances

**Files:**
- modify `apps/web/src/canvas/tools/TrackPropagateTool.ts` (`addObjectAtFrame` returns the new `{objId | objIds[]}` shape; new `removeObject(objId)` proxy)
- modify `apps/web/src/api/sam_track.ts` (extend types; add `removeObject` method)
- modify `apps/web/src/components/annotation/SamTrackPanel.tsx`:
  - Per-row "remove from track" button (icon X) calls `tool.removeObject(objId)` and prunes the local list
  - Text seed re-enabled: a single text prompt adds N objects (per detection); panel shows "Detected N people" with one row per obj_id
  - "Refine selection" — adding more clicks to an existing obj_id refines its mask (the multiplex predictor accepts repeated prompts on the same obj_id at the same frame)
- new `apps/web/tests/sam-track-multiplex-panel.test.tsx`

**Spec:**
- Multi-class is preserved: each obj_id remembers the active class at the time it was seeded (existing `classByObjId` map in TrackPropagateTool).
- Text seeds carry the active class for ALL detected objects; the user can swap class+remove individual objects from the resulting set after the fact.

### Task 6: TrackPropagateTool commit logic — multi-object polygon/mask emission

**Files:**
- modify `apps/web/src/canvas/tools/TrackPropagateTool.ts` (`commit(...)`)
- existing tests adjusted

**Spec:**
- The propagate stream now yields multi-object frames natively; the existing per-(frame, obj_id) commit logic should already handle this — verify no over-fitting to single-object output.
- Each obj_id gets its own track_id (UUID); already implemented but verify under multi-object input.

---

## Track D — Optimisation, observability, docs

### Task 7: Optimisation config + smoke benchmarks

**Files:**
- modify `docker-compose.yml` (set `SAM_DTYPE=bf16`, `SAM_ATTN_IMPL=sdpa`, `SAM_COMPILE=false` on the `model:` service env block)
- new `apps/model/scripts/sam3p1_smoke.py` — a small benchmark that loads the predictor, runs a single image text-prompt, and prints elapsed ms + peak VRAM
- new `apps/model/tests/sam/test_sam3p1_smoke.py` — skipped unless `SAM3P1_RUN_SMOKE=1`

**Spec:**
- The smoke script measures: image-encode latency, single-frame video propagate latency, peak VRAM. Used to validate optimisation tweaks (`SAM_COMPILE=true` etc.) on the actual hardware.
- Document recommended env settings for RTX 3090 (24 GB VRAM) and 4070 Ti (12 GB VRAM):
  - 4070 Ti: `SAM_DTYPE=bf16`, no compile, max_num_objects=64.
  - 3090: same, `SAM_COMPILE=true` if torch.compile is stable.

### Task 8: README / docs page

**Files:**
- new `apps/docs/sam3p1.md` — operator + developer-facing doc covering the env vars, fallback behaviour, install caveats, and the `SAM_VIDEO_BACKEND=multiplex` switch
- modify `apps/docs/index.md` to link it

---

## Self-Review Checklist (after all tasks)

- [ ] `from sam3.model_builder import build_sam3_multiplex_video_predictor` imports inside the model container.
- [ ] `Sam3ImagePredictorAdapter` loads with bf16 + sdpa.
- [ ] Image text prompt round-trips a fake "person" and returns at least one polygon.
- [ ] Image box prompt round-trips an xyxy box and returns a refined mask.
- [ ] Image point prompt round-trips a click and returns a mask.
- [ ] Video tracker: a text prompt seeds N objects in one call; `propagate_in_video` returns one mask per object per frame.
- [ ] Video tracker: a point seed at frame 0 + a box seed for a different obj_id propagate jointly to end of video.
- [ ] `DELETE .../objects/{oid}` removes the object from the in-flight session and subsequent step responses don't include it.
- [ ] Frontend: text-seed shows N rows in the Selected list; per-row remove works.
- [ ] Frontend: multi-class — switching active class between point seeds yields obj_ids on different classes.
- [ ] No regression in existing `tests/sam` and `tests/inference` suites.
- [ ] Smoke benchmark logged before/after tweaks: bf16 alone gives X ms; +sdpa gives Y ms; +compile gives Z ms (numbers go in the docs page).

## Tag

`v3.10.0 — SAM 3.1 + Object Multiplex multi-object tracker + bf16/SDPA inference optimisation`
