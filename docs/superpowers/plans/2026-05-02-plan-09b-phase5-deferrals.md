# Plan 09b — Phase 5 Deferrals (v3.9.1)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development.

**Goal:** close the six small follow-ups left by Plan 09 so the v3.9 release feels complete. All items are intentional Plan 09 deferrals; none block users today.

---

## Series context

- ✅ Plans 01–08 shipped
- ✅ v3.9.0 — Plan 09 / Phase 5 shipped (review/QA, active learning, perf, editor polish)
- **Plan 09b — Phase 5 deferrals** ← *this plan, v3.9.1 patch*

---

## Track A — UI polish

### Task 1: Mask-RLE prev-revision overlay paint

**Files:**
- modify `apps/web/src/components/annotation/AnnotationCanvas.tsx`
- new `apps/web/tests/prev-revision-mask.test.tsx`

**Spec:**
- The compare-overlay branch around the `mask_rle` no-op block (search for "Pixi 8 has no native dashed mask" comment) currently does nothing for masks.
- Replace with: decode the RLE via the existing project-side decoder (search the codebase for `decodeMaskRle` / `rleDecode` / `cocoRleDecode` — there should be one used by the live mask render path), paint the result as a translucent class-coloured fill at 30% alpha onto a Pixi `Graphics` (rectangle masked by the bitmap or via `addChild(new Sprite(Texture.fromBuffer(...)))`).
- Cleanup paths must still rmtree the compare gfx ref on asset change + on annotation deletion (existing code).
- If the existing RLE decoder is server-only (Python), just decode in JS using a small inline RLE-to-bitmap helper — masks are bounded by `size: [h, w]` already on the geometry.

**Tests:**
- A draft with `prevGeometry.kind === 'mask_rle'` and a small fake RLE produces a Pixi child node in the compare layer when hovered. Hover-out clears it. Assert via the same patterns used in `prev-revision-compare.test.tsx`.

### Task 2: Vertex-insert hover ghost dot

**Files:**
- modify `apps/web/src/components/annotation/AnnotationCanvas.tsx`
- new `apps/web/tests/polygon-vertex-insert-ghost.test.ts` (extension of polygon-vertex-insert.test.ts is fine)

**Spec:**
- When the cursor tool is active AND a polygon is selected AND the alt key is held AND the cursor is within `INSERT_TOLERANCE_PX = 6` of an edge: paint a translucent (50% alpha) class-coloured dot at the projected point.
- Updates on every pointermove (keep it cheap — single Graphics circle that moves).
- Disappears when alt is released, mouse leaves the canvas, or the polygon is deselected.

**Tests:**
- Pointermove + altKey + close-to-edge → ghost layer has one child with the right position.
- altKey released → ghost layer cleared.

### Task 3: Accepted-status checkmark badge

**Files:**
- modify `apps/web/src/components/annotation/AnnotationCanvas.tsx`
- new `apps/web/tests/accepted-checkmark.test.tsx`

**Spec:**
- Mirror the existing `rejectedAlphaMul = 0.4` plumbing: when `draft.status === 'accepted'`, paint a small green ✓ badge near the class label sprite. Use the same coordinate as the label.
- Use a lucide-react icon glyph (e.g. `Check`) or hand-drawn polyline; whichever the canvas already does for label decorations.
- Don't draw the badge for rejected (the dimming already signals state).

**Tests:**
- A draft with `status: 'accepted'` mounts a checkmark child near the label. `status: 'proposed'` does not.

---

## Track B — Data plumbing

### Task 4: Reviewer-name resolver

**Files:**
- new `apps/web/src/api/users.ts` (or extend an existing file — verify what's there)
- modify `apps/web/src/components/annotation/ReviewPanel.tsx` to consume the resolver via `resolveReviewerName` prop
- modify `apps/web/src/pages/AnnotateAssetPage.tsx` to pass it
- new `apps/web/tests/reviewer-name.test.tsx`

**Spec:**
- Add a small endpoint client `usersApi.listForWorkspace()` that returns `{ id, name, email }[]`. The backend already has `members_router` mounted — verify and reuse the existing endpoint. Adapt the response shape if needed.
- `useUsers()` hook backed by `useQuery({queryKey: ['workspace-members']})` with 5min staleTime.
- ReviewPanel rows render `Reviewed by Alice 2h ago` instead of just the time. Falls back to the user's id-prefix when the cache has no name.
- The hook is mounted once at the page level so the panel doesn't repeatedly trigger fetches.

**Tests:**
- Resolver returns the right name for a known id.
- Falls back to id-prefix for unknown id.
- ReviewPanel renders `Alice 2h ago` row when a known reviewer is present.

### Task 5: `Weight.metadata` JSONB column for retrain metrics

**Files:**
- new `apps/api/alembic/versions/0022_weight_metadata.py`
- modify `apps/api/src/carve_api/weights/models.py`
- modify `apps/api/src/carve_api/weights/schemas.py`
- modify `apps/api/src/carve_api/jobs/retrain.py` (write metrics into the new column)
- modify `apps/api/src/carve_api/weights/service.py` (`register_existing_blob` accepts metadata kwarg)
- new `apps/api/tests/weights/test_metadata.py`

**Spec:**
- Migration `0022_weight_metadata.py`: adds `metadata: JSONB | NULL` column on `weights`. Reversible.
- Update `Weight` model: `metadata_: Mapped[dict | None] = mapped_column("metadata", JSONB, nullable=True)` — note the trailing underscore to avoid clashing with SQLAlchemy's reserved `metadata` attribute.
- `WeightOut` exposes the field as `metadata`. `WeightIn` does NOT accept it.
- Retrain job writes `{"retrain": {"task_id": "...", "epochs": ..., "imgsz": ..., "include_proposed": ..., "metrics": {...}, "trained_at": "<iso8601>"}}` into the column when registering the new weight.
- Update existing tests that touch `WeightOut` if they assert on the exact field set.

**Tests:**
- Migration up + down on a clean DB.
- Retrain job sets metadata on the new weight (verify via the existing retrain test fixture).
- `WeightIn` rejects an attempt to set metadata.

---

## Track C — Refactor

### Task 6: Drop the `_require_visible_task` shims

**Files:**
- modify `apps/api/src/carve_api/assets/router.py`
- modify `apps/api/src/carve_api/annotations/router.py`

**Spec:**
- Both files keep a local `_require_visible_task(db, user, task_id)` shim that just calls `projects.service.require_visible_task(...)` and re-translates `AppError → HTTPException` via `_http(...)`.
- Replace each call site with the canonical helper directly:
  ```python
  try:
      task = require_visible_task(db, user, task_id)
  except AppError as exc:
      raise _http(exc) from exc
  ```
- Delete the local `_require_visible_task` function from both files.
- No behavioural change — the shim was a literal pass-through.

**Tests:**
- Existing tests in `apps/api/tests/assets/test_router.py` and `apps/api/tests/annotations/test_router.py` must pass unchanged.

---

## Self-Review Checklist (after all tasks)

- [ ] Mask-RLE prev-revision overlay actually paints on hover.
- [ ] Alt-hover near a polygon edge shows a translucent ghost dot.
- [ ] Accepted annotations show a checkmark badge.
- [ ] Reviewer name shows up in the panel for known users.
- [ ] Retrain produces a Weight row with metadata populated.
- [ ] No more `_require_visible_task` duplicates in `assets/router.py` or `annotations/router.py`.

## Tag

`v3.9.1 — Phase 5 deferrals`
