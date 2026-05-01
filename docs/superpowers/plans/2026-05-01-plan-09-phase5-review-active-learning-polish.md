# Plan 09 — Phase 5: Review/QA, Active Learning, Performance, Editor Polish

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development.

**Goal:** Take VisualAutoAnnotator from "annotation product" to "team-ready annotation product" by closing the four highest-value gaps: review/QA workflow, active-learning retrain, perf/stability, and editor UX polish.

**Out of scope:** Mobile/tablet annotation UX (user explicit); further work on the v3.8 Phase 4 video tracker (parked).

**Architecture:**
- New `apps/api/src/carve_api/reviews/` package for accept/reject endpoints + status querying.
- `Annotation` model gains `status`, `reviewed_by_id`, `reviewed_at`, `prev_geometry`. Alembic migration `0009_annotation_review.py`.
- Active-learning retrain: a new RQ job (`apps/api/src/carve_api/jobs/retrain.py`) that exports the task's annotations to YOLO, triggers `/yolo/train` on the model service, registers the resulting checkpoint as a new Weight.
- Perf: route-level code splitting via `React.lazy()`; large-task asset list virtualisation pass; worker per-job timeout + structured retry.
- Editor polish: shortcuts overlay, mask brush hardness slider + eraser toggle, polygon vertex insert on edge, undo grouping window.

---

## Series context
- ✅ Plans 01–08 shipped
- ✅ v3.8 Phases 1–3 (SAM polygons, Auto-annotate)
- ⏸ v3.8 Phase 4 (video tracking) — parked
- **Plan 09 — Phase 5** ← *this plan*

---

## Track A — Annotation Review / QA Workflow

### Task 1: Annotation review schema + migration

**Files:**
- modify `apps/api/src/carve_api/annotations/models.py`
- new `apps/api/alembic/versions/0009_annotation_review.py`
- modify `apps/api/src/carve_api/annotations/schemas.py`
- new `apps/api/tests/annotations/test_review_schema.py`

**Spec:**
- Add to `Annotation`:
  - `status: Mapped[str]` — `"proposed" | "accepted" | "rejected"`, default `"proposed"`, NOT NULL.
  - `reviewed_by_id: Mapped[uuid.UUID | None]` — FK to `users.id`, nullable.
  - `reviewed_at: Mapped[datetime | None]` — UTC, nullable.
  - `prev_geometry: Mapped[dict | None]` — JSONB snapshot of the geometry the last reviewer saw, nullable. Captured at every accept/reject so prev-revision compare works.
- Migration:
  - Adds the four columns, all nullable except `status` (server default `'proposed'`).
  - Adds an index on `(task_id, status)` for the review queue query.
- Schemas:
  - `AnnotationOut` exposes the new fields.
  - `AnnotationIn` does NOT accept these (only the review endpoint can mutate them).
- Tests:
  - The migration upgrade/downgrade is reversible.
  - Existing rows backfill with `status='proposed'`.

### Task 2: Review endpoints + service

**Files:**
- new `apps/api/src/carve_api/reviews/__init__.py`, `service.py`, `router.py`, `schemas.py`
- modify `apps/api/src/carve_api/main.py` (mount the new router)
- new `apps/api/tests/reviews/test_review_router.py`

**Spec:**
- `POST /annotations/{id}/review` body `{ "decision": "accept" | "reject", "note"?: string }` →
  - Sets `status` to `accepted`/`rejected`, captures `reviewed_by_id` from current user, `reviewed_at = utcnow()`, snapshots the current geometry into `prev_geometry`.
  - Returns the updated annotation row.
  - Permission: caller must have `member` or `admin` role on the annotation's task's project.
- `POST /annotations/batch:review` body `{ "ids": [uuid…], "decision": ... }` for bulk operations. Same permission. Returns counts.
- `GET /tasks/{tid}/annotations?status=proposed|accepted|rejected` filter on the existing list endpoint (extend, not duplicate).
- Updating an `accepted`/`rejected` annotation via the existing PATCH/PUT path automatically resets `status='proposed'`, clears `reviewed_*` fields, but preserves `prev_geometry` (so a reviewer can still compare to the last reviewed shape).
- Tests:
  - Reviewer accepts → row state persists, prev_geometry captured.
  - Non-member 403.
  - Bulk decision works.
  - Status filter on list endpoint.
  - Edit-after-decision flips status back to proposed.

### Task 3: Review panel in editor

**Files:**
- new `apps/web/src/components/annotation/ReviewPanel.tsx`
- modify `apps/web/src/state/annotations.ts` (status field on `AnnotationDraft`)
- modify `apps/web/src/api/annotations.ts` (review/batch:review)
- modify `apps/web/src/pages/AnnotateAssetPage.tsx` (mount panel)
- new `apps/web/tests/review-panel.test.tsx`

**Spec:**
- New right-rail panel section "Review":
  - Status chips per annotation (proposed=neutral / accepted=green / rejected=red).
  - Per-row Accept/Reject buttons; visible only when current user has member/admin role on the task.
  - "Review all proposed" CTA — bulk accept dialog with count.
  - Filter pills at top: All / Proposed / Accepted / Rejected.
- Annotations marked `rejected` render with a 60% opacity stroke on the canvas; accepted with a checkmark badge near the label.
- Keyboard: `A` accept selected, `R` reject selected (when focus isn't in an input).
- Tests:
  - Panel renders; Accept button calls API, optimistic update.
  - Filter narrows the in-memory list.
  - Edit-after-decision reverts status.

### Task 4: Prev-revision compare overlay

**Files:**
- modify `apps/web/src/components/annotation/AnnotationCanvas.tsx`
- modify `apps/web/src/components/annotation/ReviewPanel.tsx`
- new `apps/web/tests/prev-revision-compare.test.tsx`

**Spec:**
- When the user hovers a row in the Review panel that has `prev_geometry`, the canvas paints the prior shape in a dashed outline alongside the current one. Hover-out clears it.
- Toggle button on each row "Show prev" persists the overlay until clicked again.
- Diff colour picks up the row's class colour but at 50% opacity + dashed.
- Tests:
  - Hover paints the dashed overlay (assert via the Pixi mock helper used elsewhere).
  - Hover-out clears.

---

## Track B — Active Learning Loop

### Task 5: Retrain RQ job + endpoint

**Files:**
- new `apps/api/src/carve_api/jobs/retrain.py`
- new `apps/api/src/carve_api/inference/retrain_router.py` (or extend `inference/router.py`)
- modify `apps/api/src/carve_api/inference/model_client.py` (add `yolo_train`)
- modify `apps/model/src/carve_model/yolo/router.py` (add `/yolo/train`)
- new `apps/api/tests/jobs/test_retrain.py`
- new `apps/model/tests/yolo/test_train.py`

**Spec:**
- Model service `POST /yolo/train` body `{ "weight_id_base": "<wid|null>", "dataset_zip_url": "...", "epochs": 30, "imgsz": 640, "device": "auto" }`:
  - Downloads the dataset zip (YOLO format) to a temp dir.
  - Runs `ultralytics.YOLO(...).train(...)` using the supplied base weight or `yolov8n.pt` default.
  - Uploads the resulting `best.pt` to MinIO at `weights/<xxh3>/<new_weight_id>.pt`.
  - Returns `{ "weight_id": "...", "metrics": {...} }`.
- API `POST /tasks/{tid}/retrain-yolo` body `{ "base_weight_id": "<wid|null>", "epochs": 30, "imgsz": 640, "include_proposed": false }`:
  - Permission: project member/admin.
  - Schedules an RQ job that:
    1. Exports the task's `accepted` (and `proposed` when `include_proposed=true`) annotations to YOLO format using the existing `yolo_out` writer.
    2. Uploads the zip to MinIO at `retrain/<task_id>/<job_id>/dataset.zip`.
    3. Calls model service `/yolo/train` with that URL.
    4. On success: registers the new `Weight` row scoped to the task's project; copies the metrics into `Weight.metadata`.
    5. Updates Redis hash `retrain:job:<job_id>` with `phase`/`progress`/`error`.
  - Returns `{ "job_id": "..." }`.
- API `GET /tasks/{tid}/retrain-yolo/{job_id}` proxies the Redis status hash.
- API `DELETE /tasks/{tid}/retrain-yolo/{job_id}` cancels the RQ job and best-effort purges the dataset zip.
- Tests:
  - Mock `model_client.yolo_train` and assert the job pipeline writes the new weight + status hash.
  - Permission denial paths.

### Task 6: Retrain UI

**Files:**
- new `apps/web/src/components/annotation/RetrainDialog.tsx`
- modify `apps/web/src/pages/ProjectDetailPage.tsx` (kebab/menu CTA on each task row)
- modify `apps/web/src/api/weights.ts` (`retrainStart`, `retrainStatus`, `retrainCancel`)
- new `apps/web/tests/retrain-dialog.test.tsx`

**Spec:**
- Task row dropdown adds "Retrain YOLO on this task".
- Dialog asks: base weight (project's current Weight options), epochs (default 30), imgsz (default 640), include proposed (checkbox, default off).
- Submit → kicks job, dialog stays open with a real-time progress bar (poll every 1.5s).
- On success: toast `Created new weight "<weight name>". Loaded?` with `Use it` button that sets the project's active Weight.
- Cancel before completion calls the cancel endpoint and dismisses the dialog.
- Tests:
  - Dialog opens, submits, polls, success path swaps weight.

---

## Track C — Performance & Stability

### Task 7: Route-level code-splitting

**Files:**
- modify `apps/web/src/main.tsx`
- modify `apps/web/src/App.tsx` (wrap heavy routes in `React.lazy()`)
- modify `apps/web/vite.config.ts` (manual chunks for pixi, recharts, onnxruntime-web)
- modify pages whose imports pull pixi at module top-level (move into the editor page only)

**Spec:**
- Initial JS bundle (gzipped) drops below **250 kB** measured by `pnpm build && du -hb apps/web/dist/assets/*.js` (or the equivalent npm/yarn invocation in CI).
- The annotate page lazy-loads Pixi; the stats page lazy-loads recharts; the SAM browser-decoder lazy-loads onnxruntime-web.
- A loading skeleton is shown while the chunk fetches.
- Tests: a unit test asserts the build output's main entry chunk is below the budget (skip in CI if `STAT_BUNDLE=0`).

### Task 8: Large-task asset list pagination + virtualisation pass

**Files:**
- audit `apps/web/src/components/asset/AssetGrid.tsx` (or wherever the thumbnails grid lives)
- modify `apps/web/src/api/assets.ts` (cursor pagination, if not already)
- modify `apps/api/src/carve_api/assets/router.py` (cap and validate page size)
- new `apps/web/tests/asset-grid-virtualised.test.tsx`

**Spec:**
- The grid renders only visible rows (`react-virtuoso` or similar). At 10 000 assets memory + paint stays bounded.
- API caps `limit` at `500`, returns `{ items, next_cursor }`.
- Web fetches the next page when scroll passes 80% of the rendered list.
- Tests:
  - Renders with 10k mocked rows; only ~50 are mounted at any time.
  - Scroll-fetch triggers next page.

### Task 9: Worker stability — timeout + retry + structured logs

**Files:**
- modify `apps/api/src/carve_api/jobs/__init__.py` (or wherever the RQ helpers live)
- modify `apps/api/src/carve_api/jobs/predict_batch.py`, `frames.py`, future `retrain.py`
- new `apps/api/tests/jobs/test_worker_timeout.py`

**Spec:**
- Each enqueued job has an explicit `result_ttl=86400`, `failure_ttl=86400`, `job_timeout` override (predict_batch=2h, frames=30min, retrain=4h).
- A wrapper helper `run_with_retry(fn, *, attempts=3, backoff_s=10)` for transient model-service unreachable errors; non-transient errors fail immediately.
- Failures write a structured `error_traceback` snapshot to the job's status hash for later UI display.
- Tests:
  - Transient `model_service_unreachable` retries 3x then fails.
  - Long-running task is killed at `job_timeout` and reported with the timeout phase in the status hash.

---

## Track D — Editor UX Polish

### Task 10: Keyboard shortcuts cheat sheet overlay

**Files:**
- new `apps/web/src/components/annotation/ShortcutsOverlay.tsx`
- modify `apps/web/src/components/annotation/AnnotationCanvas.tsx` (key handler: `?` opens; Esc closes)
- modify `apps/web/src/components/annotation/KeyboardCheatSheet.tsx` (re-purpose if exists, else use that component as the overlay content)
- new `apps/web/tests/shortcuts-overlay.test.tsx`

**Spec:**
- Pressing `?` (anywhere in the editor while no input is focused) opens a centered modal listing all shortcuts grouped by Tool / Selection / Navigation / Review / SAM.
- Esc closes; click-outside closes.
- Discoverable via a `(?)` icon in the toolbar.
- The list is generated from a single `SHORTCUTS` array so adding new keys is a one-place edit.
- Tests:
  - `?` opens, Esc closes, click outside closes.
  - All registered shortcuts render.

### Task 11: Mask brush hardness + eraser toggle

**Files:**
- modify `apps/web/src/canvas/tools/MaskBrushTool.ts`
- modify `apps/web/src/components/annotation/EditorToolbar.tsx` (hardness slider + eraser toggle button)
- modify `apps/web/src/state/tool.ts` (new `maskHardness` and `maskEraser` fields)
- new `apps/web/tests/mask-brush-hardness.test.ts`

**Spec:**
- New `maskHardness: number` (0..1, default `0.7`) — controls the radial alpha falloff of brush dabs.
- New `maskEraser: boolean` — when true, brush subtracts from mask instead of adding (independent of right-click which already erases).
- Toolbar gets:
  - A horizontal slider next to the brush size (label "Hardness").
  - An eraser toggle button (matching the brush mode pictogram pattern).
- The MaskBrushTool's rasterizer multiplies the dab alpha by the hardness curve.
- Tests:
  - Hardness 0 → fully soft (verify alpha at radius 0.8 < alpha at radius 0.2).
  - Hardness 1 → hard edge.
  - Eraser true → painting on existing mask reduces it.

### Task 12: Polygon vertex insert on edge

**Files:**
- modify `apps/web/src/canvas/polygonEdit.ts` (hit-test for edges + insertion)
- modify `apps/web/src/components/annotation/AnnotationCanvas.tsx` (alt-click branch)
- new `apps/web/tests/polygon-vertex-insert.test.ts`

**Spec:**
- When a polygon is selected and the user **alt-clicks** within `INSERT_TOLERANCE_PX = 6` of an edge, a new vertex is inserted at the projection of the click onto that edge.
- Hover within tolerance shows a ghost vertex marker (translucent dot).
- The new vertex is immediately selected so subsequent drags move it.
- Tests:
  - Alt-click near edge inserts a vertex at the projected point.
  - Alt-click far from any edge is a no-op.

### Task 13: Undo grouping

**Files:**
- modify `apps/web/src/state/annotations.ts` (history coalescing)
- new `apps/web/tests/undo-grouping.test.ts`

**Spec:**
- Contiguous edits to the **same annotation** within `UNDO_GROUP_WINDOW_MS = 800` collapse into a single history entry.
- Distinct annotations or any non-edit action (create, delete, status change) flush the current group.
- A single Cmd-Z therefore reverts the whole drag, not one mouse-move snapshot.
- Tests:
  - 5 rapid translate ticks → one undo step.
  - Tick on annot A, tick on annot B → two undo steps.

---

## Self-Review Checklist (after all tasks)

- [ ] All migrations reversible (`alembic downgrade -1` clean).
- [ ] No regressions in existing test suites (api + model + web).
- [ ] Initial JS bundle < 250 kB gzipped.
- [ ] Reviewer can accept/reject; status persists across reload.
- [ ] Retrain job kicks off, completes, registers a new weight.
- [ ] `?` opens cheat sheet, Esc closes.
- [ ] Mask brush hardness slider visible; eraser toggle works.
- [ ] Alt-click on a polygon edge inserts a vertex.
- [ ] Cmd-Z after a polygon drag undoes the whole drag.
- [ ] Asset grid renders smoothly at 10 000 assets.

## Tag

`v3.9.0 — Phase 5: review/QA, active learning, perf, editor polish`
