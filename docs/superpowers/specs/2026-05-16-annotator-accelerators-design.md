# Annotator Accelerators — Design Spec

**Date:** 2026-05-16
**Author:** Armin Mehri
**Scope:** Seven editor accelerators chosen for highest-ROI annotator speed-up after a competitive audit (CVAT, Roboflow, Labelbox, Supervisely, V7, Encord).
**Goal:** Reduce time-per-annotation and per-image fatigue without changing existing flows.

The eighth idea — image brightness/contrast/gamma — is intentionally out of scope.

---

## Common principles

- **Additive only.** No existing keystroke, button, or flow changes.
- **Discoverable.** Every new feature has a visible affordance (button, badge, tooltip) AND a keyboard shortcut. Hidden shortcuts only ship for power-users.
- **Reversible.** Anything that mutates annotations goes through `useAnnotations` and is therefore covered by Undo.
- **Cheap.** Helpers are pure and unit-testable. Heavy work (loupe rendering, snap scanning) is bounded so the canvas never drops below 60fps.
- **Layout-independent.** Keyboard handlers prefer `e.code` over `e.key` so QWERTZ / AZERTY don't break us (per the lesson from `0bac234`).

---

## F1 — Copy from previous asset (`Ctrl+D` / `Cmd+D`)

**Why:** for sequential datasets (video frames, doc scans, time-lapse, dashcam) consecutive images are 80–95% the same. One keystroke duplicating the previous image's annotations onto the current one is the single biggest wall-clock speedup we can ship.

**Behaviour:**

1. Trigger: `Ctrl+D` (or `Cmd+D` on macOS). Plus a button in the editor toolbar's edit-actions cluster with tooltip "Copy annotations from previous asset (Ctrl+D)".
2. Source: the *previous* asset in `taskAssets` (current order, not the filter-aware order). Skip if `currentAssetIdx <= 0`.
3. For every previous-asset annotation:
   - Generate a fresh `tempId` so it round-trips as a new draft.
   - `serverId: null`, `dirty: true` so autosave POSTs it.
   - Clamp geometry to current `imageSize` (defensive; sequential assets usually share dimensions, but a mid-task resize must not produce off-image artefacts).
   - Drop annotations whose `classId` is not in the current task's `allowed_class_ids` (when a subset is set). Surface a one-line toast counting the skips.
   - Preserve `kind`, `geometry`, `zOrder`, `colorOverride`, `trackId`, `status`.
4. **Merge, never replace.** Existing annotations on the current asset are untouched. Copied annotations land on top.
5. Bulk-add to the store as a single undo entry (one push to `history.past`).
6. Toast: `Copied N annotations from <prev asset name>`. If 0 valid → `Nothing to copy from previous asset`.

**Edge cases:**
- No previous asset → toast `No previous asset`, no-op.
- Previous asset's annotations not yet loaded → fetch synchronously before copy.
- All previous annotations dropped by class-subset filter → toast `0 copied (N skipped — classes not in this task)`.
- Polygon/mask geometry larger than current image → clamp; if collapsed below 4px edge, drop.

**Files:**
- New: `apps/web/src/lib/copy-from-previous.ts` (pure helper — `copyAnnotationsToTarget(source, currentImageSize, allowedClassIds) → {accepted, skipped}`).
- New: `apps/web/tests/copy-from-previous.test.ts` (table-driven cases above).
- Modified: `apps/web/src/pages/AnnotateAssetPage.tsx` (hotkey + toolbar action wiring; reads the prev asset's cached annotations from React Query and falls back to a fetch).
- Modified: `apps/web/src/components/annotation/EditorToolbar.tsx` (new button in the edit-actions cluster).

---

## F2 — Next empty / next unreviewed nav (`]` `[` `Shift+]` `Shift+[`)

**Why:** in QA passes you skim past completed images. Today the only nav is ArrowLeft/Right (one step at a time) and the filter-aware skip. A direct "next image that needs work" jumps over swathes of finished assets.

**Behaviour:**

1. `]` / `[` → next / prev asset with **zero annotations** in this task.
2. `Shift+]` / `Shift+[` → next / prev asset with at least one annotation whose status is **not** `accepted` (i.e. `proposed` or `rejected` — needs human attention).
3. Data source: the existing `["task-annotations-raw", taskId]` query that powers filter-aware nav. Already keyed; just walk it.
4. **Always global** (ignores active filter), because the user invoking these wants "where's the work" not "where's the filter match".
5. When no candidate exists → toast `No empty/unreviewed assets remain` and no nav.

**Edge cases:**
- Task-annotations-raw not yet loaded → on first press, fire fetch + toast `Searching…`, then nav when ready.
- Current asset matches → still advance to the *next* match (caller probably wants to step forward).
- All assets match → walks one-by-one (boring but correct).
- Modifier keys collide with `Cmd+]` macOS bracket → require no Cmd/Ctrl: pure `]` only.

**Files:**
- New: `apps/web/src/lib/asset-skip-nav.ts` (pure: `findNextEmpty(assets, raw, currentIdx, direction) → asset | null`, same for unreviewed).
- New: `apps/web/tests/asset-skip-nav.test.ts`.
- Modified: `AnnotateAssetPage.tsx` keyboard handler.
- Modified: `KeyboardCheatSheet.tsx` documents the new shortcuts.

---

## F3 — Annotation health flags

**Why:** annotators (and especially batch auto-annotate runs) produce noisy outputs nobody catches until export-day. Surfacing suspicious annotations inline in the editor keeps quality high during the work, not after.

**Detectors (per-annotation, additive):**

| Code | Condition | Severity |
|---|---|---|
| `tiny` | bbox `w<4` or `h<4` image-px | warn |
| `off-image` | any vertex outside `[0, imageSize]` | warn |
| `extreme-aspect` | bbox aspect ratio `> 50:1` or `< 1:50` | warn |
| `whole-image` | bbox area `> 80%` of image area | info |
| `degenerate-polygon` | polygon with `< 3` unique points | warn |
| `duplicate-class-iou` | same-class neighbour with bbox-IoU `> 0.8` | warn |

**UI:**
- A small chip in the editor right rail: "⚠ 4 issues". Click → expands a list with one row per flagged annotation showing the code + a "Focus" button. Focus selects the annotation and pans/zooms the canvas onto it.
- The annotation itself gets a discreet `!` badge on its label tag when flagged (only when `Show labels` is on).
- A "Hide flagged" filter so the user can dismiss noise that doesn't apply to their task type.

**Edge cases:**
- Performance: detectors are O(N) per call (duplicate-class-iou is O(N²) per class but bounded by per-class buckets, expected < 50 per class). Memoize against `[byId, hiddenIds]`. Only recompute on store change.
- Hidden / locked annotations are excluded — they're intentional.
- Detector returns CODES not messages so localisation later is one swap.

**Files:**
- New: `apps/web/src/lib/annotation-health.ts` (pure detectors + an aggregator returning `Flag[]`).
- New: `apps/web/tests/annotation-health.test.ts`.
- New: `apps/web/src/components/annotation/HealthPanel.tsx` (right-rail chip + expandable list).
- Modified: `AnnotateAssetPage.tsx` mounts the panel.

---

## F4 — Streak indicator

**Why:** when a user draws 5 cars in a row, the active-class panel doesn't tell them anything special. A small `🔥 ×5` streak chip next to the active class name gives them peripheral awareness ("am I on autopilot? am I missing a Truck?") with zero behaviour change.

**Behaviour:**

1. Track `lastDrawClassId` and `streakCount` in `useTool` (volatile, never persisted).
2. `addAnnotation(classId)` from a tool: if `classId === lastDrawClassId`, increment; else reset to `1`.
3. Render a small `🔥 N` chip on that class's row in `ClassesPanel` when `N >= 3`.
4. Programmatic additions (paste, copy-from-prev, SAM batch) do **NOT** count as streak draws — only tool-driven user actions.
5. Switching the active class manually does NOT reset the streak counter unless the user actually draws something else.

**Edge cases:**
- Bulk paste shouldn't break the streak when it's the same class — keep the existing streak intact (additive bookkeeping treats paste as "not a tool draw" so streak stays).
- Class deletion → if `lastDrawClassId` is the deleted one, clear the streak.
- Project/task switch → reset.

**Files:**
- Modified: `apps/web/src/state/tool.ts` — add `lastDrawClassId`, `streakCount`, `recordDraw(classId)`, `resetStreak()`.
- Modified: `apps/web/src/canvas/tools/BboxTool.ts` and `PolygonTool.ts` — call `recordDraw` after a successful create.
- Modified: `apps/web/src/components/annotation/ClassesPanel.tsx` — render the streak chip.
- New: `apps/web/tests/streak-indicator.test.ts` (store-level test of `recordDraw`).

---

## F5 — Drag-select marquee (cursor mode)

**Why:** the only multi-select today is shift-clicking each annotation in turn. A marquee rectangle is the standard interaction for selecting many shapes at once.

**Behaviour:**

1. Active tool is `cursor`. Pointer-down lands on **empty area** (no hit-test match) → start marquee at that anchor.
2. As the pointer moves, render a dashed white rectangle (same look as the crosshair guide) with a 6 % white fill for legibility.
3. Pointer-up → compute the marquee's image-space rect; select every visible annotation whose bbox intersects it.
4. Modifiers:
   - No modifier → REPLACE selection.
   - `Shift` → ADD to the current selection.
   - `Alt` (option) → REMOVE from the current selection.
5. Hidden / class-hidden annotations are skipped. Locked annotations may be selected (read-only is fine), they just won't be movable as a group.
6. Cancellation: `Escape` mid-drag aborts.

**Intersection rule:** AABB-intersect (a tiny overlap counts). CVAT uses "fully contained" by default; we go with intersect because it's friendlier for messy data and matches user instinct in most UX studies.

**Edge cases:**
- Sub-MIN_DRAG distance (under 4px) → treat as a click, not a marquee. Falls back to existing deselect-on-empty-click behaviour.
- Marquee crosses image edge → clamp the rect to image bounds before intersection so off-image annotations (rare but exist) are still selectable.
- Performance: linear scan over visible annotations; for 5k annotations the loop is ~0.5ms. No spatial index needed in v1.

**Files:**
- New: `apps/web/src/lib/marquee-select.ts` — `rectIntersectsAnnotation(rect, draft)` + `marqueeHits(rect, drafts) → string[]`.
- New: `apps/web/tests/marquee-select.test.ts`.
- Modified: `AnnotationCanvas.tsx` — pointer handler for cursor mode learns the marquee state machine (anchor → move → up), renders the Pixi graphic.

---

## F6 — Edge / annotation snap (hold `Shift`)

**Why:** lining up adjacent boxes pixel-perfectly takes a lot of nudging today. Optional snapping lets the cursor lock to existing vertices and edges so adjacent annotations share boundaries cleanly.

**Behaviour:**

1. Snapping is OFF by default. Enable: hold `Shift` while drawing a bbox or polygon. (Shift is unmodified during normal drag; we observe it on every pointer-move.)
2. Targets:
   - Every vertex of every visible non-self annotation.
   - Edges of every visible non-self bbox / polygon (perpendicular projection of cursor onto the edge segment).
3. Threshold: **8 screen-pixels** (so the threshold tightens as the user zooms in — felt distance stays constant).
4. Tie-breaker: nearest target wins; vertex ties beat edge ties at equal distance.
5. Visual feedback: a small white filled dot at the snap target while snapping is active, plus a 1px white outline on the line/box element being snapped to.
6. Snapping affects both the live preview and the committed geometry. Releasing Shift mid-draw returns to free-motion immediately.

**Edge cases:**
- Snapping must not snap to the in-progress polygon's own vertices (or you can't draw anything). Self-exclusion via the in-flight tempId or by passing the in-progress vertices separately.
- Snapping must not include locked annotations? Decision: include them — they're a positioning reference even when uneditable.
- Very low zoom (large screen pixel per image pixel ratio): the 8 screen-px threshold could translate to many image-pixels; clamp the image-space threshold to a max of 24 image-px so snapping doesn't become "jump several feet".
- Performance: 50k vertices/edges scan is the upper bound; we keep it linear and early-terminate when a within-threshold candidate is found within the loop. Acceptable for v1.

**Files:**
- New: `apps/web/src/lib/snap-target.ts` — pure `findSnapTarget(cursorImagePx, scale, drafts, excludeId) → {x, y, kind: 'vertex' | 'edge'} | null`.
- New: `apps/web/tests/snap-target.test.ts`.
- Modified: `BboxTool.ts` + `PolygonTool.ts` accept an optional cursor-snap callback.
- Modified: `AnnotationCanvas.tsx` plumbs the callback when Shift is held; renders the snap-dot.

---

## F7 — Magnifier / loupe (hold `Z`)

**Why:** small targets (faces in crowd photos, defects, distant vehicles in satellite imagery) demand sub-pixel precision. A loupe is the universal solution — every serious annotation tool ships one.

**Behaviour:**

1. Hold `Z` → live magnifier follows the pointer. Release → disappears. (We use `e.code === "KeyZ"` so layouts don't break.)
2. Visual: 220px diameter circle, **4×** zoom by default. Position: offset 16px down-right from the cursor; flip to up-left when the loupe would overlap the image edge.
3. Content: a render of the underlying Pixi sprite at zoom factor, plus any annotation strokes scaled to match (so the user sees BOTH the pixels AND the in-progress draw).
4. Configurable in Appearance panel: zoom factor 2×–8× slider, size 160–320 slider.
5. Loupe is opt-in via a toolbar button (persistent) AND the keyboard hold.

**Edge cases:**
- Cursor outside the image → hide the loupe.
- Pixi app not ready yet (texture loading) → hide.
- High-DPI displays → render at devicePixelRatio for sharp interior pixels.
- The loupe must not consume pointer events — `pointer-events: none` on the container.
- Performance: Pixi `RenderTexture` of the visible region per frame. Cap to 30 fps via a microtask throttle if devtools say > 1 ms per call.

**Files:**
- New: `apps/web/src/canvas/Loupe.ts` — encapsulated Pixi sub-renderer (`init(app)`, `setEnabled(b)`, `update(cursorX, cursorY)`, `destroy()`).
- New: `apps/web/tests/loupe-pure.test.ts` — only the *pure* parts (clamp logic, flip-positioning math).
- Modified: `AnnotationCanvas.tsx` mounts the loupe alongside the main app; wires Z hold + toolbar button.
- Modified: `editorSettings.ts` adds `loupeZoom` (default 4) and `loupeSize` (default 220).
- Modified: `AppearancePanel.tsx` adds the two sliders + a "Show loupe" toggle.

---

## Build order

1. **F1 Copy-from-previous** — independent, biggest impact.
2. **F2 Skip-nav** — independent, small surface.
3. **F3 Health flags** — independent, additive panel.
4. **F4 Streak indicator** — small, low risk.
5. **F5 Marquee select** — touches canvas pointer state.
6. **F6 Snap** — touches drawing tools.
7. **F7 Loupe** — heaviest, needs Pixi RenderTexture.
8. **Full test sweep** — vitest run, tsc, backend pytest, browser smoke.

Each feature lands as its own commit with its own unit-test suite. The PR-style ordering above means earlier landings never block later ones.

---

## Out of scope (for future)

- Image enhancement filters (brightness/contrast/gamma) — explicitly excluded by Armin.
- Voice commands.
- Smart polygon edit ops (split/merge by line).
- Cross-user collaboration features.
- Multi-image batch ops from a list view.
