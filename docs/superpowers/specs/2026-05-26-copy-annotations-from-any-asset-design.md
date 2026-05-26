# Copy Annotations From Any Asset — Design Spec

**Date:** 2026-05-26
**Author:** Armin Mehri
**Scope:** Extend the existing "copy annotations from previous asset" flow (`Ctrl+Shift+D`) so the operator can copy annotations from *any* asset in the task — not just the immediately preceding one.
**Goal:** Make cross-image annotation reuse practical when source and target are not adjacent (e.g. image 10 → image 25) without altering the existing `Ctrl+Shift+D` flow, the helper signature, or the annotation store contract.

---

## Common principles

- **Additive only.** `Ctrl+Shift+D` and the underlying `copyAnnotationsToTarget` helper keep their current behaviour. Every change is new code or new wiring around them.
- **Discoverable.** The feature ships with two affordances: a right-click context menu on thumbnails (mouse-first) and a `Shift+P` hotkey (keyboard-first).
- **Confirmable.** Unlike the single-keystroke `Ctrl+Shift+D` (which acts on the previous asset — easy to mentally model), an arbitrary-source copy is committed only after the operator confirms a dialog that shows the source preview, source filename, and breakdown by annotation kind.
- **Reversible.** Mutations go through `useAnnotations.addMany()` and are therefore covered by Undo.
- **Image-only (v1).** Same restriction as the existing helper. Video→video frame-correspondence remains out of scope.

---

## UX

### Trigger A — right-click thumbnail (mouse-first)

1. Operator right-clicks any non-active thumbnail in the `AssetThumbnailStrip`.
2. A small context menu opens anchored at the cursor.
3. Single menu item (v1): **"Copy annotations to current asset"**. The menu is suppressed entirely on the active tile (copying to self is meaningless).
4. Clicking the item opens the **CopyAnnotationsDialog** pre-populated with that source asset.

The context menu is implemented as a portal-rendered floating element pinned to the cursor location, dismissed by Esc, click-away, or scroll. It does **not** alter the existing `<Link>` left-click navigation — `contextmenu` is a separate event.

### Trigger B — `Shift+P` (keyboard-first)

1. Operator presses `Shift+P` while in the editor (only when no text input is focused — same guard as the existing `g` jump-to).
2. The **CopyFromPromptDialog** opens: a number input identical in shape to the existing jump-to prompt.
3. Operator types the asset ordinal `1..N`, presses `Enter`.
4. If the ordinal is valid and not the current asset, the **CopyAnnotationsDialog** opens for that source asset. Esc dismisses without copying.
5. If the ordinal is invalid or equals the current asset ordinal, the prompt shows an inline error and stays open.

### CopyAnnotationsDialog — the shared confirm step

Both triggers funnel into the same modal so the surface area is small and predictable.

The dialog body contains:
- A 128×96 thumbnail preview of the source asset (reuses `asset.thumbnail_url` from the cached task-assets query — no extra fetch).
- Source filename in bold, plus ordinal in a faint tabular-nums chip: `IMG_0042.jpg · 42 / 1247`.
- The arrow + target hint: `→ current asset: IMG_0098.jpg`.
- Breakdown line: `17 bbox · 3 polygon`. Counts are computed from the same `task-annotations-raw` cache `Ctrl+Shift+D` already uses; this query is pre-loaded on editor mount so the dialog opens with the breakdown ready.
- When the current asset already has annotations: an extra subtle hint `Adds to 4 existing annotations (Cmd+Z to undo)`.
- When the source has 0 annotations: the breakdown reads `Nothing to copy` and the primary button is disabled and labelled `Close`.

Buttons:
- `Cancel` (secondary, Esc).
- `Copy N annotations` (primary, Enter). Label updates live with the count actually committable after class/geometry filtering.

When the operator confirms:
- The dialog calls the existing `copyAnnotationsToTarget` helper via the new `copy-from-asset.ts` wrapper.
- On success, dialog closes and a toast renders identical to the existing `Ctrl+Shift+D` toast: `Copied N annotations from "<source name>"` plus the `M skipped (class)` / `M skipped (off-image)` tails when applicable.
- On 0 accepted (all skipped), the dialog stays open with the relevant warning so the operator can re-decide.

---

## Architecture

```
                  ┌─────────────────────────────────────┐
                  │   CopyAnnotationsDialog (NEW)       │
                  │   - preview, breakdown, confirm     │
                  │   - calls copy-from-asset wrapper   │
                  └──────────────┬──────────────────────┘
                                 │  reuses
                                 ▼
                  ┌─────────────────────────────────────┐
                  │   copy-from-previous.ts             │
                  │   copyAnnotationsToTarget()         │
                  │   (existing pure helper, unchanged) │
                  └─────────────────────────────────────┘
   ▲                              ▲
   │ opens dialog                  │ opens dialog
   │                               │
┌──┴──────────────────┐    ┌───────┴──────────────────────┐
│ ThumbContextMenu    │    │ CopyFromPromptDialog (NEW)   │
│ (NEW) — opened on   │    │ — number input, Enter        │
│ right-click of any  │    │ submits, Esc cancels         │
│ non-active thumb    │    │                              │
└──────────┬──────────┘    └──────────────┬───────────────┘
           │                              │
           │ wired by                     │ wired by
           ▼                              ▼
   AssetThumbnailStrip            AnnotateAssetPage shortcut
   (contextmenu handler)          handler for `copy_from_any_asset`
```

### State ownership

Dialog open/close state lives on `AnnotateAssetPage` (same module that owns the existing `runCopyFromPreviousAsset` and the asset / annotation queries). The strip emits a callback (`onContextMenuCopy(sourceAssetId)`) which the page interprets as "open the dialog with this source". This keeps the strip free of dialog state and free of the `task-annotations-raw` query subscription.

### Wrapper helper

A new thin wrapper `apps/web/src/lib/copy-from-asset.ts` exposes:

```ts
async function copyAnnotationsFromAssetTo(opts: {
  sourceAssetId: string;
  targetAsset: Asset;            // current asset, with width/height
  taskId: string;
  taskClasses: TaskClassesResponse | undefined;
  frameId: string | null;
  qc: QueryClient;
}): Promise<CopyResult & { sourceName: string; sourceTotal: number }>;
```

It does exactly what the existing inline `runCopyFromPreviousAsset` in `AnnotateAssetPage` does, just parameterised by `sourceAssetId` instead of "previous index". The existing inline implementation is then refactored to call this wrapper — a single source of truth for fetch + filter + helper invocation. This is a small, focused refactor that improves the existing code while servicing the new feature.

---

## Shortcut wiring

A new action registers in `apps/web/src/lib/shortcuts/actions.ts`:

```ts
{
  id: "copy_from_any_asset",
  defaultCombo: ["Shift", "P"],
  category: "Navigation",
  label: "Copy annotations from an asset",
}
```

The existing `copy_from_previous_asset` action is unchanged.

`KeyboardCheatSheet.tsx` lists both:
- `Ctrl+Shift+D` — Copy annotations from previous asset
- `Shift+P` — Copy annotations from any asset (opens picker)

---

## Files

| File | Status | Purpose |
|------|--------|---------|
| `apps/web/src/components/annotation/CopyAnnotationsDialog.tsx` | NEW (~140 lines) | Confirm dialog rendered by `AnnotateAssetPage` |
| `apps/web/src/components/annotation/CopyFromPromptDialog.tsx` | NEW (~80 lines) | `Shift+P` number-input prompt |
| `apps/web/src/components/annotation/ThumbContextMenu.tsx` | NEW (~60 lines) | Right-click portal menu |
| `apps/web/src/lib/copy-from-asset.ts` | NEW (~70 lines) | Source-agnostic wrapper around `copyAnnotationsToTarget` |
| `apps/web/src/components/annotation/AssetThumbnailStrip.tsx` | edit (+25 lines) | Add `onContextMenu` on tiles, prop `onCopyAnnotationsFromAsset?(id)` |
| `apps/web/src/pages/AnnotateAssetPage.tsx` | edit (+50 lines) | Dialog state, shortcut handler, refactor existing `runCopyFromPreviousAsset` to call new wrapper |
| `apps/web/src/lib/shortcuts/actions.ts` | edit (+8 lines) | Register `copy_from_any_asset` action |
| `apps/web/src/components/annotation/KeyboardCheatSheet.tsx` | edit (+3 lines) | List new shortcut |
| `apps/web/src/lib/copy-from-previous.test.ts` | edit (+30 lines) | Cover the new wrapper with arbitrary-source cases |
| `apps/web/src/components/annotation/__tests__/CopyAnnotationsDialog.test.tsx` | NEW (~80 lines) | Dialog renders correct counts, primary button disabled at 0 |

Total: ~430 new lines, ~115 edits, 1 new test file + 1 test edit. No backend changes, no migrations, no API additions.

---

## Behaviour decisions (locked)

| Aspect | Decision | Rationale |
|--------|----------|-----------|
| Merge vs replace on target | **Add on top** | Matches `Ctrl+Shift+D`. Cmd+Z undoes. Replace would be a new destructive primitive — out of scope. |
| Source = current asset | **Menu hidden; hotkey rejects with toast** | "Copy to self" is meaningless. |
| Video assets | **Blocked with toast** (`"Copy from asset is image-only in v1"`) | Same v1 limitation as existing helper. |
| Class subset filtering | **Reuse existing helper** | `allowedClassIds` already handled. |
| Geometry clamp / off-image drop | **Reuse existing helper** | Same skip counts in toast. |
| Undo | **Cmd+Z works for free** | Adds via `useAnnotations.addMany()` — already part of undo stack. |
| Source picker order | **Same as `taskAssets`** (current order, not filter-aware) | Matches `Ctrl+Shift+D` semantics; ordinal in `Shift+P` prompt corresponds to the strip ordering. |
| Right-click while a tile drag is in flight | **Ignore** | No conflict with multi-select (left-click only) or with drag-and-drop bulk move (also left-click). |

---

## Out of scope (v2 candidates)

- Multi-source copy (pick 2+ assets, union their annotations).
- Replace-mode (toggle in the dialog: "Clear current and copy").
- Video→video frame correspondence.
- Cross-task copy (source in a different task).
- Class-level filter at copy time ("only copy bboxes" / "only copy class X").

These are intentionally deferred. The v1 surface is small, reuses the existing helper end-to-end, and ships with both mouse and keyboard entry points.

---

## Risks and how the design contains them

1. **Misfire from right-click**: confirm dialog prevents any accidental writes — right-clicking the wrong tile never mutates data on its own.
2. **Hotkey collision**: `Shift+P` is currently unbound. The shortcut handler is gated on "no text input focused" via the existing `useShortcutHandler` plumbing.
3. **`task-annotations-raw` query coldness**: when the dialog opens before that cache is populated, the breakdown line shows a small spinner; the primary button is disabled until the count resolves. No additional pollers — uses the same query the page already warms.
4. **Long task lists (1000+ assets)**: the right-click menu is per-tile and doesn't enumerate the task. The hotkey prompt is a number input — no large list rendering. O(1) UI cost.
5. **Breakage of `Ctrl+Shift+D`**: the existing handler is refactored to call the new wrapper. The refactor is behaviour-preserving and is covered by the existing `copy-from-previous.test.ts` suite plus the new wrapper tests.
6. **Stale source thumbnail in dialog**: the dialog reads `asset.thumbnail_url` from the strip's TanStack Query cache, which the May 26 fix already keeps fresh via `staleTime: 5min` and `refetchOnWindowFocus`. No additional URL refresh path needed.

---

## Test plan

Unit (Vitest):
- `copy-from-asset.test.ts` — arbitrary source asset id passes through to `copyAnnotationsToTarget` with correct args; rejects when source = target; toasts when source has no annotations.
- `CopyAnnotationsDialog.test.tsx` — renders correct breakdown counts; primary button disabled at 0; clicking confirm calls the wrapper exactly once.
- `CopyFromPromptDialog.test.tsx` — rejects out-of-range, rejects self-target, Enter on valid opens dialog.

Component (Testing Library):
- `AssetThumbnailStrip.test.tsx` — right-click on non-active tile fires `onCopyAnnotationsFromAsset(id)`; right-click on active tile does nothing.

Manual verification (mandatory before commit):
- Right-click → menu → confirm copies on a real task with 20+ images. Verify toast, count, Cmd+Z, no double-application on rapid clicks.
- `Shift+P` → enter `1` → confirm. Same checks.
- Video task: both flows show the image-only toast and do nothing.
- Empty source: dialog shows "Nothing to copy" and `Close` button.
- `Ctrl+Shift+D` still copies from previous asset with identical behaviour.
