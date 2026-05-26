# Copy Annotations From Any Asset — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend `Ctrl+Shift+D` (copy annotations from previous asset) so the operator can copy annotations from *any* asset in the task via a right-click context menu on thumbnails OR a `Shift+P` number-input prompt. Both flows funnel into one shared confirm dialog. Existing `Ctrl+Shift+D` shortcut is preserved.

**Architecture:** Existing pure helper `copyAnnotationsToTarget` stays unchanged. A new thin wrapper `copy-from-asset.ts` parameterises source asset id and absorbs the fetch + filter + toast logic currently inlined in `AnnotateAssetPage.runCopyFromPreviousAsset`. Three small new UI components — `ThumbContextMenu`, `CopyFromPromptDialog`, `CopyAnnotationsDialog` — sit in front of the wrapper. The strip emits a callback; the page owns dialog state.

**Tech Stack:** React 18 + TanStack Query + Zustand + Vitest + Testing Library + Radix Dialog. No backend changes.

**Spec:** `docs/superpowers/specs/2026-05-26-copy-annotations-from-any-asset-design.md`

---

## File Structure

### Created

| Path | Responsibility |
|---|---|
| `apps/web/src/lib/copy-from-asset.ts` | Source-agnostic wrapper around `copyAnnotationsToTarget`: fetches `task-annotations-raw`, filters by source id, runs helper, returns `{ accepted, skippedByClass, skippedByGeometry, sourceName, sourceTotal }` |
| `apps/web/src/lib/copy-from-asset.test.ts` | Vitest coverage for the wrapper |
| `apps/web/src/components/annotation/CopyAnnotationsDialog.tsx` | Confirm dialog with source preview, breakdown, primary `Copy N annotations` button |
| `apps/web/src/components/annotation/__tests__/CopyAnnotationsDialog.test.tsx` | Component test for breakdown rendering + button state |
| `apps/web/src/components/annotation/CopyFromPromptDialog.tsx` | `Shift+P` number-input prompt opening the confirm dialog on valid ordinal |
| `apps/web/src/components/annotation/__tests__/CopyFromPromptDialog.test.tsx` | Component test for ordinal validation + Enter behaviour |
| `apps/web/src/components/annotation/ThumbContextMenu.tsx` | Portal-rendered context menu with "Copy annotations to current asset" item |
| `apps/web/src/components/annotation/__tests__/ThumbContextMenu.test.tsx` | Component test for open/dismiss/keyboard |

### Modified

| Path | Responsibility |
|---|---|
| `apps/web/src/lib/shortcuts/actions.ts` (around line 193) | Register `copy_from_any_asset` action with default `shift+p` |
| `apps/web/src/components/annotation/AssetThumbnailStrip.tsx` | Add `onContextMenuCopy?(assetId, pos)` prop; wire `onContextMenu` on every non-active tile |
| `apps/web/src/pages/AnnotateAssetPage.tsx` (around lines 1236-1338, plus mount area near `KeyboardCheatSheet`) | Refactor `runCopyFromPreviousAsset` to delegate to the wrapper; add dialog state, breakdown computation, Shift+P handler, dialog/menu mounts |
| `apps/web/src/components/annotation/KeyboardCheatSheet.tsx` (around lines 175 and 278) | List `copy_from_any_asset` next to `copy_from_previous_asset` |

---

## Test Strategy

- **TDD throughout:** every new file starts with a failing test.
- **Pure helper first** (Task 2) before UI (Tasks 4-6). Wrapping the existing pure helper means we build everything else without touching live React state.
- **Existing test suite stays green:** Task 3 refactors `runCopyFromPreviousAsset` to use the wrapper, but the existing `copy-from-previous.test.ts` suite is unchanged and must still pass after Task 3.
- **Manual verification** (Task 10) covers the real Pixi canvas + Cmd+Z roundtrip that unit tests cannot cover.

Vitest command for any single file:

```
cd apps/web && pnpm vitest run path/to/file.test.ts
```

Full web suite (for regression checkpoints):

```
cd apps/web && pnpm vitest run
```

Type check after every task:

```
cd apps/web && pnpm tsc --noEmit --pretty false
```

---

## Task 1: Register the new shortcut action

**Files:**
- Modify: `apps/web/src/lib/shortcuts/actions.ts`

- [ ] **Step 1: Insert the new action definition right after `copy_from_previous_asset`**

Open `apps/web/src/lib/shortcuts/actions.ts` and locate the `copy_from_previous_asset` entry (around line 187-193). Add a new entry directly after it:

```ts
  {
    id: "copy_from_any_asset",
    label: "Copy annotations from any asset",
    category: "Editor",
    default: "shift+p",
    description:
      "Open a picker to copy every annotation from any asset in the task onto the current one. Right-click a thumbnail to use the menu instead.",
  },
```

- [ ] **Step 2: Type-check**

Run: `cd apps/web && pnpm tsc --noEmit --pretty false`
Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/lib/shortcuts/actions.ts
git commit -m "feat(shortcuts): register copy_from_any_asset action (Shift+P)"
```

---

## Task 2: Wrapper helper with TDD

**Files:**
- Create: `apps/web/src/lib/copy-from-asset.ts`
- Test: `apps/web/src/lib/copy-from-asset.test.ts`

The wrapper takes a `sourceAssetId` and an opts bag, fetches `task-annotations-raw` from the React Query cache (or refetches if cold), filters source rows, maps to `CopySource[]`, and calls the existing `copyAnnotationsToTarget`. It returns the helper's `CopyResult` augmented with `sourceName` and `sourceTotal` so callers can render `Copied N annotations from "<source>"` and `Nothing to copy` toasts identical to today's.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/lib/copy-from-asset.test.ts`:

```ts
// Armin Mehri — mehri.armin@gmail.com
import { describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { copyAnnotationsFromAssetTo } from "./copy-from-asset";
import type { Asset } from "@/api/assets";

interface RawAnno {
  id: string;
  asset_id: string;
  class_id: string;
  kind: "bbox" | "polygon" | "tag" | "mask_rle";
  geometry: unknown;
}

function makeAsset(over: Partial<Asset>): Asset {
  return {
    id: over.id ?? "target",
    task_id: "t1",
    kind: "image",
    xxh3_128: "x",
    mime: "image/png",
    size_bytes: 1,
    width: 1000,
    height: 800,
    frames: 1,
    original_name: over.original_name ?? "target.png",
    created_at: "2026-05-26T00:00:00Z",
    thumbnail_url: null,
    ...over,
  } as Asset;
}

function seedRawQuery(qc: QueryClient, rows: RawAnno[]) {
  qc.setQueryData(["task-annotations-raw", "t1"], rows);
}

describe("copyAnnotationsFromAssetTo", () => {
  it("returns accepted drafts when source has annotations", async () => {
    const qc = new QueryClient();
    seedRawQuery(qc, [
      {
        id: "a1",
        asset_id: "src",
        class_id: "c1",
        kind: "bbox",
        geometry: { kind: "bbox", x: 10, y: 10, w: 200, h: 100 },
      },
    ]);

    const res = await copyAnnotationsFromAssetTo({
      sourceAssetId: "src",
      targetAsset: makeAsset({ id: "target" }),
      taskId: "t1",
      allowedClassIds: null,
      frameId: "f1",
      qc,
    });

    expect(res.sourceTotal).toBe(1);
    expect(res.accepted).toHaveLength(1);
    expect(res.skippedByClass).toBe(0);
    expect(res.skippedByGeometry).toBe(0);
  });

  it("reports zero accepted and surfaces sourceTotal:0 when source has no annotations", async () => {
    const qc = new QueryClient();
    seedRawQuery(qc, []);

    const res = await copyAnnotationsFromAssetTo({
      sourceAssetId: "src",
      targetAsset: makeAsset({ id: "target" }),
      taskId: "t1",
      allowedClassIds: null,
      frameId: null,
      qc,
    });

    expect(res.sourceTotal).toBe(0);
    expect(res.accepted).toHaveLength(0);
  });

  it("rejects when sourceAssetId equals targetAsset.id", async () => {
    const qc = new QueryClient();
    seedRawQuery(qc, []);

    await expect(
      copyAnnotationsFromAssetTo({
        sourceAssetId: "same",
        targetAsset: makeAsset({ id: "same" }),
        taskId: "t1",
        allowedClassIds: null,
        frameId: null,
        qc,
      }),
    ).rejects.toThrowError(/same/i);
  });

  it("respects allowedClassIds whitelist", async () => {
    const qc = new QueryClient();
    seedRawQuery(qc, [
      {
        id: "a1",
        asset_id: "src",
        class_id: "OK",
        kind: "bbox",
        geometry: { kind: "bbox", x: 0, y: 0, w: 100, h: 100 },
      },
      {
        id: "a2",
        asset_id: "src",
        class_id: "BLOCKED",
        kind: "bbox",
        geometry: { kind: "bbox", x: 0, y: 0, w: 100, h: 100 },
      },
    ]);

    const res = await copyAnnotationsFromAssetTo({
      sourceAssetId: "src",
      targetAsset: makeAsset({ id: "target" }),
      taskId: "t1",
      allowedClassIds: new Set(["OK"]),
      frameId: null,
      qc,
    });

    expect(res.accepted).toHaveLength(1);
    expect(res.accepted[0].classId).toBe("OK");
    expect(res.skippedByClass).toBe(1);
  });

  it("rejects when target asset is a video", async () => {
    const qc = new QueryClient();
    seedRawQuery(qc, []);
    await expect(
      copyAnnotationsFromAssetTo({
        sourceAssetId: "src",
        targetAsset: makeAsset({ id: "target", kind: "video" as const }),
        taskId: "t1",
        allowedClassIds: null,
        frameId: null,
        qc,
      }),
    ).rejects.toThrowError(/image-only/i);
  });

  it("fetches the raw query when the cache is cold", async () => {
    const qc = new QueryClient();
    const fetchSpy = vi
      .spyOn(qc, "fetchQuery")
      .mockResolvedValueOnce([] as never);

    await copyAnnotationsFromAssetTo({
      sourceAssetId: "src",
      targetAsset: makeAsset({ id: "target" }),
      taskId: "t1",
      allowedClassIds: null,
      frameId: null,
      qc,
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][0]).toMatchObject({
      queryKey: ["task-annotations-raw", "t1"],
    });
  });
});
```

- [ ] **Step 2: Run the test — it should fail (module not found)**

Run: `cd apps/web && pnpm vitest run src/lib/copy-from-asset.test.ts`
Expected: FAIL `Cannot find module './copy-from-asset'`.

- [ ] **Step 3: Implement the wrapper**

Create `apps/web/src/lib/copy-from-asset.ts`:

```ts
// Armin Mehri — mehri.armin@gmail.com
/**
 * Source-agnostic annotation copy.
 *
 * Wraps the existing pure ``copyAnnotationsToTarget`` helper with the
 * fetch + filter + sanity-check logic the editor needs in order to
 * copy annotations from any asset in the task (not just the previous
 * one). Keeping this orchestration in its own file means:
 *   - the previous-asset shortcut and the new arbitrary-source UI
 *     call the same code path,
 *   - it is unit-testable without mounting React,
 *   - the editor page stays focused on UI / state wiring.
 *
 * v1 limitation: image -> image only. ``targetAsset.kind === "video"``
 * is rejected with a clear error; the caller renders a toast.
 */
import type { QueryClient } from "@tanstack/react-query";
import { annotationsApi } from "@/api/annotations";
import type { Asset } from "@/api/assets";
import {
  copyAnnotationsToTarget,
  type CopyResult,
  type CopySource,
} from "@/lib/copy-from-previous";
import type { Geometry } from "@/state/annotations";

export interface CopyFromAssetOpts {
  /** Asset id whose annotations should be copied forward. */
  readonly sourceAssetId: string;
  /** Current asset (the copy target). Needed for image-only check + dimensions. */
  readonly targetAsset: Asset;
  /** Task this copy is scoped to. The raw-annotations query is task-scoped. */
  readonly taskId: string;
  /** Whitelist of legal class ids; pass null for "no subset restriction". */
  readonly allowedClassIds: ReadonlySet<string> | null;
  /** ``frame_id`` to stamp onto every copied draft. */
  readonly frameId: string | null;
  /** Shared QueryClient — used for cache read-through + on-demand fetch. */
  readonly qc: QueryClient;
}

export interface CopyFromAssetResult extends CopyResult {
  /** Source asset filename — filled by the caller from taskAssets after the wrapper returns. */
  sourceName: string;
  /** How many rows existed on the source asset (before any filtering). */
  sourceTotal: number;
}

/**
 * Fetch + filter + run the pure helper. Throws on input validation
 * errors (same-asset, video target) so the caller can show a toast.
 */
export async function copyAnnotationsFromAssetTo(
  opts: CopyFromAssetOpts,
): Promise<CopyFromAssetResult> {
  const {
    sourceAssetId,
    targetAsset,
    taskId,
    allowedClassIds,
    frameId,
    qc,
  } = opts;

  if (sourceAssetId === targetAsset.id) {
    throw new Error(
      "Source and target are the same asset — nothing to copy.",
    );
  }
  if (targetAsset.kind !== "image") {
    throw new Error(
      "Copy annotations is image-only in v1 (video coming soon).",
    );
  }

  const raw = await qc.fetchQuery({
    queryKey: ["task-annotations-raw", taskId],
    queryFn: () => annotationsApi.listForTaskRaw(taskId),
    staleTime: 0,
  });

  const sourceRows = raw.filter((r) => r.asset_id === sourceAssetId);
  if (sourceRows.length === 0) {
    return {
      accepted: [],
      skippedByClass: 0,
      skippedByGeometry: 0,
      sourceName: "",
      sourceTotal: 0,
    };
  }

  const targetSize =
    typeof targetAsset.width === "number" &&
    typeof targetAsset.height === "number"
      ? { w: targetAsset.width, h: targetAsset.height }
      : null;

  const source: CopySource[] = sourceRows.map((r) => ({
    classId: r.class_id,
    kind: r.kind,
    geometry: r.geometry as unknown as Geometry,
  }));

  const result = copyAnnotationsToTarget(source, {
    targetImageSize: targetSize,
    allowedClassIds,
    targetFrameId: frameId,
    genTempId: () =>
      `c-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  });

  return {
    ...result,
    sourceName: "",
    sourceTotal: sourceRows.length,
  };
}
```

- [ ] **Step 4: Run the test — it should pass**

Run: `cd apps/web && pnpm vitest run src/lib/copy-from-asset.test.ts`
Expected: 6 passed.

- [ ] **Step 5: Type-check + commit**

```bash
cd apps/web && pnpm tsc --noEmit --pretty false
cd /home/media4us/Documents/Dev/VisualAutoAnnotator
git add apps/web/src/lib/copy-from-asset.ts apps/web/src/lib/copy-from-asset.test.ts
git commit -m "feat(lib): copy-from-asset wrapper for arbitrary-source annotation copy"
```

---

## Task 3: Refactor `runCopyFromPreviousAsset` to use the wrapper

**Goal:** prove the wrapper is a drop-in for the existing `Ctrl+Shift+D` path. After this task, the existing `copy-from-previous.test.ts` suite must still be green AND the existing shortcut must still work in the UI.

**Files:**
- Modify: `apps/web/src/pages/AnnotateAssetPage.tsx` (around lines 1236-1338)

- [ ] **Step 1: Add the wrapper import**

Find the existing `import { ... } from "@/lib/copy-from-previous";` line near the top of `AnnotateAssetPage.tsx` (around line 126). Add a sibling import directly below it:

```ts
import { copyAnnotationsFromAssetTo } from "@/lib/copy-from-asset";
```

- [ ] **Step 2: Replace the inline implementation of `runCopyFromPreviousAsset`**

Replace the body of `runCopyFromPreviousAsset` with:

```ts
  const runCopyFromPreviousAsset = useCallback(async () => {
    if (currentAssetIdx <= 0) {
      showToast("No previous asset to copy from.", { variant: "info" });
      return;
    }
    const prev = taskAssets[currentAssetIdx - 1];
    const curr = assetQ.data?.asset;
    if (!prev || !curr) {
      showToast("Asset metadata not loaded yet — try again in a moment.", {
        variant: "warning",
      });
      return;
    }
    if (prev.kind !== "image") {
      showToast(
        "Copy from previous asset is image-only in v1 (video coming soon).",
        { variant: "info" },
      );
      return;
    }
    const allowed = taskClassesQ.data?.allowed_class_ids ?? null;
    const allowedSet = allowed ? new Set<string>(allowed) : null;

    let result;
    try {
      result = await copyAnnotationsFromAssetTo({
        sourceAssetId: prev.id,
        targetAsset: curr,
        taskId,
        allowedClassIds: allowedSet,
        frameId: frameIdRef.current,
        qc,
      });
    } catch (err) {
      showToast(
        err instanceof Error ? err.message : "Couldn't copy annotations.",
        { variant: "error" },
      );
      return;
    }

    if (result.sourceTotal === 0) {
      showToast(
        `No annotations on previous asset "${prev.original_name}".`,
        { variant: "info" },
      );
      return;
    }
    if (result.accepted.length === 0) {
      if (result.skippedByClass > 0 && result.skippedByGeometry === 0) {
        showToast(
          `0 copied — all ${result.skippedByClass} annotations use classes not in this task.`,
          { variant: "warning" },
        );
      } else if (
        result.skippedByGeometry > 0 &&
        result.skippedByClass === 0
      ) {
        showToast(
          `0 copied — ${result.skippedByGeometry} annotations had geometry incompatible with this image.`,
          { variant: "warning" },
        );
      } else {
        showToast("Nothing valid to copy from previous asset.", {
          variant: "info",
        });
      }
      return;
    }

    useAnnotations.getState().addMany(result.accepted);
    const parts: string[] = [
      `Copied ${result.accepted.length} annotation${result.accepted.length === 1 ? "" : "s"}`,
      `from "${prev.original_name}"`,
    ];
    const tail: string[] = [];
    if (result.skippedByClass > 0)
      tail.push(`${result.skippedByClass} skipped (class)`);
    if (result.skippedByGeometry > 0)
      tail.push(`${result.skippedByGeometry} skipped (off-image)`);
    const msg =
      tail.length > 0
        ? `${parts.join(" ")} · ${tail.join(", ")}`
        : parts.join(" ") + ".";
    showToast(msg, { variant: "success" });
  }, [
    currentAssetIdx,
    taskAssets,
    assetQ.data?.asset,
    qc,
    taskId,
    taskClassesQ.data?.allowed_class_ids,
  ]);
```

- [ ] **Step 3: Clean up unused imports**

If `copyAnnotationsToTarget`, `CopySource`, or `Geometry` are no longer referenced in `AnnotateAssetPage.tsx` after the refactor, remove them from the existing import block. Run `pnpm tsc --noEmit --pretty false` — TypeScript will flag unused imports if `noUnusedLocals` is on.

- [ ] **Step 4: Verify existing tests still pass**

Run: `cd apps/web && pnpm vitest run src/lib/copy-from-previous.test.ts`
Expected: all previously-passing tests still PASS.

Run: `cd apps/web && pnpm vitest run src/lib/copy-from-asset.test.ts`
Expected: 6 PASS.

- [ ] **Step 5: Type-check + commit**

```bash
cd apps/web && pnpm tsc --noEmit --pretty false
cd /home/media4us/Documents/Dev/VisualAutoAnnotator
git add apps/web/src/pages/AnnotateAssetPage.tsx
git commit -m "refactor(editor): route Ctrl+Shift+D through copy-from-asset wrapper

Behaviour-preserving — the existing copy-from-previous.test.ts suite
still passes. Sets up the wrapper as the single source of truth for
the arbitrary-source feature in subsequent tasks."
```

---

## Task 4: `CopyAnnotationsDialog` component with TDD

**Files:**
- Create: `apps/web/src/components/annotation/CopyAnnotationsDialog.tsx`
- Test: `apps/web/src/components/annotation/__tests__/CopyAnnotationsDialog.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/components/annotation/__tests__/CopyAnnotationsDialog.test.tsx`:

```tsx
// Armin Mehri — mehri.armin@gmail.com
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { CopyAnnotationsDialog } from "../CopyAnnotationsDialog";
import type { Asset } from "@/api/assets";

function makeAsset(over: Partial<Asset>): Asset {
  return {
    id: over.id ?? "a",
    task_id: "t",
    kind: "image",
    xxh3_128: "x",
    mime: "image/png",
    size_bytes: 1,
    width: 1000,
    height: 800,
    frames: 1,
    original_name: over.original_name ?? "a.png",
    created_at: "2026-05-26T00:00:00Z",
    thumbnail_url: over.thumbnail_url ?? null,
    ...over,
  } as Asset;
}

describe("CopyAnnotationsDialog", () => {
  it("renders the breakdown line for non-zero counts", () => {
    render(
      <CopyAnnotationsDialog
        open
        onOpenChange={() => {}}
        sourceAsset={makeAsset({ id: "src", original_name: "src.png" })}
        sourceOrdinal={42}
        totalAssets={1247}
        targetAsset={makeAsset({ id: "tgt", original_name: "tgt.png" })}
        targetExistingCount={4}
        breakdown={{ bbox: 17, polygon: 3, tag: 0, mask: 0, total: 20 }}
        onConfirm={() => Promise.resolve()}
      />,
    );

    expect(screen.getByText(/src\.png/)).toBeInTheDocument();
    expect(screen.getByText(/42 ?\/ ?1247/)).toBeInTheDocument();
    expect(screen.getByText(/17 bbox/)).toBeInTheDocument();
    expect(screen.getByText(/3 polygon/)).toBeInTheDocument();
    expect(screen.getByText(/Adds to 4 existing annotations/)).toBeInTheDocument();

    const confirmBtn = screen.getByRole("button", { name: /Copy 20 annotations/i });
    expect(confirmBtn).not.toBeDisabled();
  });

  it("shows 'Nothing to copy' and a Close button when breakdown total is 0", () => {
    render(
      <CopyAnnotationsDialog
        open
        onOpenChange={() => {}}
        sourceAsset={makeAsset({ id: "src", original_name: "src.png" })}
        sourceOrdinal={1}
        totalAssets={10}
        targetAsset={makeAsset({ id: "tgt", original_name: "tgt.png" })}
        targetExistingCount={0}
        breakdown={{ bbox: 0, polygon: 0, tag: 0, mask: 0, total: 0 }}
        onConfirm={() => Promise.resolve()}
      />,
    );

    expect(screen.getByText(/Nothing to copy/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Close/i })).toBeInTheDocument();
  });

  it("shows a spinner while breakdown is loading and disables confirm", () => {
    render(
      <CopyAnnotationsDialog
        open
        onOpenChange={() => {}}
        sourceAsset={makeAsset({ id: "src" })}
        sourceOrdinal={2}
        totalAssets={10}
        targetAsset={makeAsset({ id: "tgt" })}
        targetExistingCount={0}
        breakdown="loading"
        onConfirm={() => Promise.resolve()}
      />,
    );

    expect(screen.getByTestId("copy-dialog-breakdown-loading")).toBeInTheDocument();
    const btn = screen.getByRole("button", { name: /Copy/i });
    expect(btn).toBeDisabled();
  });

  it("calls onConfirm exactly once when the primary button is clicked", async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    render(
      <CopyAnnotationsDialog
        open
        onOpenChange={() => {}}
        sourceAsset={makeAsset({ id: "src" })}
        sourceOrdinal={1}
        totalAssets={10}
        targetAsset={makeAsset({ id: "tgt" })}
        targetExistingCount={0}
        breakdown={{ bbox: 1, polygon: 0, tag: 0, mask: 0, total: 1 }}
        onConfirm={onConfirm}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Copy 1 annotation/i }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run — should fail (module not found)**

Run: `cd apps/web && pnpm vitest run src/components/annotation/__tests__/CopyAnnotationsDialog.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement**

Create `apps/web/src/components/annotation/CopyAnnotationsDialog.tsx`:

```tsx
// Armin Mehri — mehri.armin@gmail.com
/**
 * Copy-annotations confirm dialog. Funnel point for both the
 * right-click context-menu flow and the Shift+P prompt flow. Shows the
 * source preview + filename + ordinal + breakdown by kind, plus a
 * "Adds to N existing annotations" hint when the current asset is
 * non-empty. The primary button is disabled when the breakdown is
 * still loading or when there is nothing to copy.
 *
 * Pure presentational — no fetch, no store mutation. The parent owns
 * the wrapper call and the toast.
 */
import { Loader2, ArrowRight } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";
import type { Asset } from "@/api/assets";

export interface BreakdownCounts {
  readonly bbox: number;
  readonly polygon: number;
  readonly tag: number;
  readonly mask: number;
  readonly total: number;
}

export interface CopyAnnotationsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sourceAsset: Asset | null;
  sourceOrdinal: number | null;
  totalAssets: number;
  targetAsset: Asset | null;
  targetExistingCount: number;
  breakdown: BreakdownCounts | "loading" | null;
  onConfirm: () => Promise<void> | void;
}

function pluralize(n: number, singular: string, plural?: string): string {
  return n === 1 ? singular : (plural ?? `${singular}s`);
}

function renderBreakdownLine(b: BreakdownCounts): string {
  if (b.total === 0) return "Nothing to copy";
  const parts: string[] = [];
  if (b.bbox > 0)
    parts.push(`${b.bbox} ${pluralize(b.bbox, "bbox", "bboxes")}`);
  if (b.polygon > 0) parts.push(`${b.polygon} ${pluralize(b.polygon, "polygon")}`);
  if (b.tag > 0) parts.push(`${b.tag} ${pluralize(b.tag, "tag")}`);
  if (b.mask > 0) parts.push(`${b.mask} ${pluralize(b.mask, "mask")}`);
  return parts.join(" · ");
}

export function CopyAnnotationsDialog({
  open,
  onOpenChange,
  sourceAsset,
  sourceOrdinal,
  totalAssets,
  targetAsset,
  targetExistingCount,
  breakdown,
  onConfirm,
}: CopyAnnotationsDialogProps) {
  const loading = breakdown === "loading";
  const counts = breakdown && breakdown !== "loading" ? breakdown : null;
  const total = counts?.total ?? 0;
  const empty = !loading && counts !== null && total === 0;

  const primaryLabel = empty
    ? "Close"
    : `Copy ${total} ${pluralize(total, "annotation")}`;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-[440px]"
        data-testid="copy-annotations-dialog"
      >
        <DialogHeader>
          <DialogTitle>Copy annotations</DialogTitle>
        </DialogHeader>

        <div className="grid grid-cols-[112px_1fr] gap-3 py-2">
          <div
            className={cn(
              "h-[84px] w-[112px] rounded-[var(--radius-sm)] border",
              "border-[var(--border-subtle)] overflow-hidden bg-[var(--bg-subtle)]",
            )}
            data-testid="copy-dialog-source-thumb"
          >
            {sourceAsset?.thumbnail_url ? (
              <img
                src={sourceAsset.thumbnail_url}
                alt={sourceAsset.original_name}
                className="h-full w-full object-cover"
                decoding="async"
              />
            ) : null}
          </div>
          <div className="flex flex-col justify-center gap-1 min-w-0">
            <div className="flex items-baseline gap-2 min-w-0">
              <span className="text-[13px] font-medium text-[color:var(--text-primary)] truncate">
                {sourceAsset?.original_name ?? "—"}
              </span>
              {sourceOrdinal !== null && totalAssets > 0 && (
                <span className="text-[11px] tabular-nums text-[color:var(--text-tertiary)] shrink-0">
                  {sourceOrdinal} / {totalAssets}
                </span>
              )}
            </div>
            <div className="flex items-center gap-1.5 text-[11.5px] text-[color:var(--text-secondary)]">
              <ArrowRight className="h-3 w-3" aria-hidden />
              <span className="truncate">
                current asset: {targetAsset?.original_name ?? "—"}
              </span>
            </div>
            <div className="text-[12px] text-[color:var(--text-primary)] min-h-[16px]">
              {loading ? (
                <span
                  className="inline-flex items-center gap-1.5 text-[color:var(--text-tertiary)]"
                  data-testid="copy-dialog-breakdown-loading"
                >
                  <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
                  Counting annotations…
                </span>
              ) : counts ? (
                <span data-testid="copy-dialog-breakdown">
                  {renderBreakdownLine(counts)}
                </span>
              ) : null}
            </div>
            {!empty && !loading && targetExistingCount > 0 && (
              <span className="text-[11px] text-[color:var(--text-tertiary)]">
                Adds to {targetExistingCount} existing{" "}
                {pluralize(targetExistingCount, "annotation")} (Cmd+Z to undo)
              </span>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            data-testid="copy-dialog-cancel"
          >
            Cancel
          </Button>
          <Button
            variant={empty ? "ghost" : "default"}
            disabled={loading}
            onClick={async () => {
              if (empty) {
                onOpenChange(false);
                return;
              }
              await onConfirm();
            }}
            data-testid="copy-dialog-confirm"
          >
            {primaryLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 4: Run — should pass**

Run: `cd apps/web && pnpm vitest run src/components/annotation/__tests__/CopyAnnotationsDialog.test.tsx`
Expected: 4 passed.

- [ ] **Step 5: Type-check + commit**

```bash
cd apps/web && pnpm tsc --noEmit --pretty false
cd /home/media4us/Documents/Dev/VisualAutoAnnotator
git add apps/web/src/components/annotation/CopyAnnotationsDialog.tsx apps/web/src/components/annotation/__tests__/CopyAnnotationsDialog.test.tsx
git commit -m "feat(editor): CopyAnnotationsDialog confirm component"
```

---

## Task 5: `CopyFromPromptDialog` component with TDD

**Files:**
- Create: `apps/web/src/components/annotation/CopyFromPromptDialog.tsx`
- Test: `apps/web/src/components/annotation/__tests__/CopyFromPromptDialog.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/components/annotation/__tests__/CopyFromPromptDialog.test.tsx`:

```tsx
// Armin Mehri — mehri.armin@gmail.com
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { CopyFromPromptDialog } from "../CopyFromPromptDialog";

describe("CopyFromPromptDialog", () => {
  it("calls onPick with the entered ordinal on Enter for a valid value", () => {
    const onPick = vi.fn();
    render(
      <CopyFromPromptDialog
        open
        onOpenChange={() => {}}
        totalAssets={1247}
        currentOrdinal={98}
        onPick={onPick}
      />,
    );
    const input = screen.getByTestId("copy-prompt-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "42" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onPick).toHaveBeenCalledWith(42);
  });

  it("rejects ordinals out of range and keeps the dialog open", () => {
    const onPick = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <CopyFromPromptDialog
        open
        onOpenChange={onOpenChange}
        totalAssets={10}
        currentOrdinal={5}
        onPick={onPick}
      />,
    );
    const input = screen.getByTestId("copy-prompt-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "99" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onPick).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(screen.getByTestId("copy-prompt-error")).toBeInTheDocument();
  });

  it("rejects when the entered ordinal equals currentOrdinal", () => {
    const onPick = vi.fn();
    render(
      <CopyFromPromptDialog
        open
        onOpenChange={() => {}}
        totalAssets={10}
        currentOrdinal={5}
        onPick={onPick}
      />,
    );
    const input = screen.getByTestId("copy-prompt-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "5" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onPick).not.toHaveBeenCalled();
    expect(screen.getByTestId("copy-prompt-error").textContent).toMatch(/same as current/i);
  });

  it("dismisses on Escape", () => {
    const onOpenChange = vi.fn();
    render(
      <CopyFromPromptDialog
        open
        onOpenChange={onOpenChange}
        totalAssets={10}
        currentOrdinal={5}
        onPick={vi.fn()}
      />,
    );
    const input = screen.getByTestId("copy-prompt-input") as HTMLInputElement;
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
```

- [ ] **Step 2: Run — should fail**

Run: `cd apps/web && pnpm vitest run src/components/annotation/__tests__/CopyFromPromptDialog.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement**

Create `apps/web/src/components/annotation/CopyFromPromptDialog.tsx`:

```tsx
// Armin Mehri — mehri.armin@gmail.com
/**
 * Keyboard-first asset picker for the "copy annotations from any
 * asset" flow. Opens on Shift+P, accepts a 1-based ordinal in
 * ``[1, totalAssets]`` excluding the current asset's ordinal, calls
 * ``onPick`` on Enter, dismisses on Escape. Mirrors the existing 'g'
 * jump-to UX so the muscle memory transfers.
 */
import { useEffect, useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/Dialog";
import { Input } from "@/components/ui/Input";
import { cn } from "@/lib/cn";

export interface CopyFromPromptDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  totalAssets: number;
  currentOrdinal: number;
  onPick: (ordinal: number) => void;
}

export function CopyFromPromptDialog({
  open,
  onOpenChange,
  totalAssets,
  currentOrdinal,
  onPick,
}: CopyFromPromptDialogProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setDraft("");
      setError(null);
      // Defer focus so Radix's mount transition doesn't steal it back.
      const id = window.setTimeout(() => inputRef.current?.focus(), 0);
      return () => window.clearTimeout(id);
    }
    return undefined;
  }, [open]);

  function submit() {
    const n = parseInt(draft, 10);
    if (!Number.isFinite(n)) {
      setError("Enter a number.");
      return;
    }
    if (n < 1 || n > totalAssets) {
      setError(`Out of range — pick 1 to ${totalAssets}.`);
      return;
    }
    if (n === currentOrdinal) {
      setError("Same as current asset.");
      return;
    }
    onPick(n);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-[360px]"
        data-testid="copy-prompt-dialog"
      >
        <DialogHeader>
          <DialogTitle>Copy annotations from…</DialogTitle>
        </DialogHeader>
        <div className="flex items-center gap-2 py-2">
          <Input
            ref={inputRef}
            type="number"
            min={1}
            max={totalAssets}
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submit();
              } else if (e.key === "Escape") {
                e.preventDefault();
                onOpenChange(false);
              }
            }}
            data-testid="copy-prompt-input"
            placeholder="Asset #"
            className="w-32"
            aria-label="Asset number"
          />
          <span className="font-mono text-[12px] text-[color:var(--text-tertiary)]">
            / {totalAssets}
          </span>
        </div>
        {error && (
          <span
            className={cn(
              "text-[11.5px] text-[color:var(--danger,#d4504a)]",
            )}
            role="alert"
            data-testid="copy-prompt-error"
          >
            {error}
          </span>
        )}
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 4: Run — should pass**

Run: `cd apps/web && pnpm vitest run src/components/annotation/__tests__/CopyFromPromptDialog.test.tsx`
Expected: 4 passed.

- [ ] **Step 5: Type-check + commit**

```bash
cd apps/web && pnpm tsc --noEmit --pretty false
cd /home/media4us/Documents/Dev/VisualAutoAnnotator
git add apps/web/src/components/annotation/CopyFromPromptDialog.tsx apps/web/src/components/annotation/__tests__/CopyFromPromptDialog.test.tsx
git commit -m "feat(editor): CopyFromPromptDialog Shift+P picker"
```

---

## Task 6: `ThumbContextMenu` component with TDD

**Files:**
- Create: `apps/web/src/components/annotation/ThumbContextMenu.tsx`
- Test: `apps/web/src/components/annotation/__tests__/ThumbContextMenu.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/components/annotation/__tests__/ThumbContextMenu.test.tsx`:

```tsx
// Armin Mehri — mehri.armin@gmail.com
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ThumbContextMenu } from "../ThumbContextMenu";

describe("ThumbContextMenu", () => {
  it("renders only when open", () => {
    const { rerender } = render(
      <ThumbContextMenu open={false} x={10} y={10} onClose={() => {}} onCopy={() => {}} />,
    );
    expect(screen.queryByTestId("thumb-context-menu")).not.toBeInTheDocument();
    rerender(
      <ThumbContextMenu open x={10} y={10} onClose={() => {}} onCopy={() => {}} />,
    );
    expect(screen.getByTestId("thumb-context-menu")).toBeInTheDocument();
  });

  it("calls onCopy then onClose when the copy item is clicked", () => {
    const onCopy = vi.fn();
    const onClose = vi.fn();
    render(<ThumbContextMenu open x={50} y={50} onCopy={onCopy} onClose={onClose} />);
    fireEvent.click(screen.getByTestId("thumb-context-menu-copy"));
    expect(onCopy).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("calls onClose on Escape", () => {
    const onClose = vi.fn();
    render(<ThumbContextMenu open x={50} y={50} onCopy={() => {}} onClose={onClose} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("calls onClose on outside mousedown", () => {
    const onClose = vi.fn();
    render(<ThumbContextMenu open x={50} y={50} onCopy={() => {}} onClose={onClose} />);
    fireEvent.mouseDown(document.body);
    expect(onClose).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run — should fail**

Run: `cd apps/web && pnpm vitest run src/components/annotation/__tests__/ThumbContextMenu.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement**

Create `apps/web/src/components/annotation/ThumbContextMenu.tsx`:

```tsx
// Armin Mehri — mehri.armin@gmail.com
/**
 * Portal-rendered context menu for thumbnail right-clicks. Single
 * item in v1: "Copy annotations to current asset". Dismisses on Esc,
 * outside mousedown, or scroll. Pinned in the viewport via fixed
 * positioning at the supplied (x, y) — the parent computes that from
 * the contextmenu event's clientX/Y.
 */
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { Copy } from "lucide-react";
import { cn } from "@/lib/cn";

export interface ThumbContextMenuProps {
  open: boolean;
  x: number;
  y: number;
  onClose: () => void;
  onCopy: () => void;
}

export function ThumbContextMenu({
  open,
  x,
  y,
  onClose,
  onCopy,
}: ThumbContextMenuProps) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return undefined;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    }
    function onMouseDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    }
    function onScroll() {
      onClose();
    }
    window.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onMouseDown);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open, onClose]);

  if (!open) return null;

  const style: React.CSSProperties = {
    position: "fixed",
    left: `${x + 2}px`,
    top: `${y + 4}px`,
    zIndex: 80,
  };

  return createPortal(
    <div
      ref={ref}
      role="menu"
      data-testid="thumb-context-menu"
      style={style}
      className={cn(
        "min-w-[220px] py-1",
        "rounded-[var(--radius-md)] border border-[var(--border-subtle)]",
        "bg-[var(--bg-elev)] shadow-xl",
        "text-[12.5px] text-[color:var(--text-primary)]",
      )}
    >
      <button
        type="button"
        role="menuitem"
        onClick={() => {
          onCopy();
          onClose();
        }}
        data-testid="thumb-context-menu-copy"
        className={cn(
          "w-full text-left flex items-center gap-2 px-3 py-1.5",
          "hover:bg-[var(--bg-hover)]",
        )}
      >
        <Copy className="h-3.5 w-3.5" aria-hidden />
        Copy annotations to current asset
      </button>
    </div>,
    document.body,
  );
}
```

- [ ] **Step 4: Run — should pass**

Run: `cd apps/web && pnpm vitest run src/components/annotation/__tests__/ThumbContextMenu.test.tsx`
Expected: 4 passed.

- [ ] **Step 5: Type-check + commit**

```bash
cd apps/web && pnpm tsc --noEmit --pretty false
cd /home/media4us/Documents/Dev/VisualAutoAnnotator
git add apps/web/src/components/annotation/ThumbContextMenu.tsx apps/web/src/components/annotation/__tests__/ThumbContextMenu.test.tsx
git commit -m "feat(editor): ThumbContextMenu for thumbnail right-click"
```

---

## Task 7: Wire `ThumbContextMenu` into `AssetThumbnailStrip`

**Files:**
- Modify: `apps/web/src/components/annotation/AssetThumbnailStrip.tsx`

- [ ] **Step 1: Extend the Props interface**

In `apps/web/src/components/annotation/AssetThumbnailStrip.tsx`, find the `interface Props` block (around line 31). Add a new optional prop directly under `onBulkTag`:

```ts
  /**
   * Feature May 26 — right-click a non-active tile fires this. The
   * host page mounts the actual context menu + dialog; the strip only
   * emits the request (with cursor coordinates) so it stays free of
   * dialog state.
   */
  onContextMenuCopy?: (assetId: string, pos: { x: number; y: number }) => void;
```

- [ ] **Step 2: Accept the prop in the destructure**

Update the function signature to include the new prop:

```tsx
export function AssetThumbnailStrip({
  taskId,
  projectId,
  activeAssetId,
  onBulkDelete,
  onBulkMove,
  onBulkTag,
  onContextMenuCopy,
}: Props) {
```

- [ ] **Step 3: Wrap the existing tile render with the `onContextMenu` handler**

Find the `virtualItems.map((vi) => { ... return ( <div key={asset.id} style={style}> ... )` block. Replace the wrapper `<div>` with a version that handles `onContextMenu`:

```tsx
            const isActive = asset.id === activeAssetId;
            return (
              <div
                key={asset.id}
                style={style}
                onContextMenu={(e) => {
                  if (!onContextMenuCopy) return;
                  if (isActive) return;
                  e.preventDefault();
                  onContextMenuCopy(asset.id, { x: e.clientX, y: e.clientY });
                }}
              >
                <ThumbItem
                  asset={asset}
                  projectId={projectId}
                  taskId={taskId}
                  active={isActive}
                  selected={selectedAssetIds.has(asset.id)}
                  pending={isActive && activeAssetPending}
                  onClick={(e) => handleThumbClick(vi.index, asset, e)}
                />
              </div>
            );
```

- [ ] **Step 4: Type-check**

Run: `cd apps/web && pnpm tsc --noEmit --pretty false`
Expected: 0 errors.

- [ ] **Step 5: Commit**

```bash
cd /home/media4us/Documents/Dev/VisualAutoAnnotator
git add apps/web/src/components/annotation/AssetThumbnailStrip.tsx
git commit -m "feat(strip): onContextMenuCopy callback for thumbnail right-click"
```

---

## Task 8: Wire dialog state + Shift+P handler into `AnnotateAssetPage`

The page becomes the single owner of:
- `copyDialogSourceId: string | null` — confirm dialog open/close + which source.
- `copyPromptOpen: boolean` — Shift+P prompt visibility.
- `thumbMenu: { sourceAssetId, x, y } | null` — right-click menu state.
- The breakdown computation from the cached `task-annotations-raw` query.
- The `runCopyFromAsset(sourceAssetId)` handler called by the dialog confirm button.

**Files:**
- Modify: `apps/web/src/pages/AnnotateAssetPage.tsx`

- [ ] **Step 1: Add imports**

Near the existing `import { copyAnnotationsFromAssetTo } from "@/lib/copy-from-asset";` line (added in Task 3), add:

```ts
import {
  CopyAnnotationsDialog,
  type BreakdownCounts,
} from "@/components/annotation/CopyAnnotationsDialog";
import { CopyFromPromptDialog } from "@/components/annotation/CopyFromPromptDialog";
import { ThumbContextMenu } from "@/components/annotation/ThumbContextMenu";
```

Verify `useMemo`, `useState`, `useQuery`, and `annotationsApi` are already imported (they should be — they're used elsewhere in this file). If not, add them.

- [ ] **Step 2: Add state hooks near the existing `runCopyFromPreviousAsset` definition**

Below the existing `runCopyFromPreviousAsset` definition, add:

```ts
  // Arbitrary-source copy state. Single source of truth so right-click
  // menu + Shift+P prompt + the dialog all stay in sync without prop
  // ping-pong with the strip.
  const [copyDialogSourceId, setCopyDialogSourceId] = useState<string | null>(
    null,
  );
  const [copyPromptOpen, setCopyPromptOpen] = useState(false);
  const [thumbMenu, setThumbMenu] = useState<{
    sourceAssetId: string;
    x: number;
    y: number;
  } | null>(null);

  // Pre-warm the raw-annotations query so the dialog opens with the
  // breakdown ready in the common case. ``runCopyFromPreviousAsset``
  // already uses this cache, so warming it on editor mount costs
  // nothing extra.
  const taskAnnotationsRawQ = useQuery({
    queryKey: ["task-annotations-raw", taskId],
    queryFn: () => annotationsApi.listForTaskRaw(taskId),
    staleTime: 30_000,
  });

  // Compute the breakdown for the currently-selected source. We do
  // the work here (in the page) rather than inside the dialog so the
  // dialog stays pure presentation and we don't subscribe to
  // TanStack from a modal that mounts/unmounts. Returns ``"loading"``
  // while the query is in flight, ``null`` when no source is
  // selected, or a counts object otherwise.
  const copyDialogBreakdown: BreakdownCounts | "loading" | null = useMemo(() => {
    if (!copyDialogSourceId) return null;
    if (taskAnnotationsRawQ.isLoading || !taskAnnotationsRawQ.data)
      return "loading";
    const rows = taskAnnotationsRawQ.data.filter(
      (r) => r.asset_id === copyDialogSourceId,
    );
    const counts: BreakdownCounts = {
      bbox: 0,
      polygon: 0,
      tag: 0,
      mask: 0,
      total: rows.length,
    };
    for (const r of rows) {
      if (r.kind === "bbox") counts.bbox += 1;
      else if (r.kind === "polygon") counts.polygon += 1;
      else if (r.kind === "tag") counts.tag += 1;
      else if (r.kind === "mask_rle") counts.mask += 1;
    }
    return counts;
  }, [
    copyDialogSourceId,
    taskAnnotationsRawQ.data,
    taskAnnotationsRawQ.isLoading,
  ]);

  // Existing-annotation count for the target asset (the "Adds to N"
  // hint). Reads the live store so it reflects unsaved drafts too.
  const targetExistingCount = useAnnotations(
    (s) => s.byAsset[assetId]?.length ?? 0,
  );

  const dialogSourceAsset = useMemo(
    () =>
      copyDialogSourceId
        ? taskAssets.find((a) => a.id === copyDialogSourceId) ?? null
        : null,
    [copyDialogSourceId, taskAssets],
  );
  const dialogSourceOrdinal = useMemo(() => {
    if (!copyDialogSourceId) return null;
    const idx = taskAssets.findIndex((a) => a.id === copyDialogSourceId);
    return idx >= 0 ? idx + 1 : null;
  }, [copyDialogSourceId, taskAssets]);

  const runCopyFromAsset = useCallback(
    async (sourceAssetId: string) => {
      const curr = assetQ.data?.asset;
      if (!curr) {
        showToast(
          "Asset metadata not loaded yet — try again in a moment.",
          { variant: "warning" },
        );
        return;
      }
      const sourceAsset = taskAssets.find((a) => a.id === sourceAssetId);
      const sourceName = sourceAsset?.original_name ?? "(unknown)";
      const allowed = taskClassesQ.data?.allowed_class_ids ?? null;
      const allowedSet = allowed ? new Set<string>(allowed) : null;
      let result;
      try {
        result = await copyAnnotationsFromAssetTo({
          sourceAssetId,
          targetAsset: curr,
          taskId,
          allowedClassIds: allowedSet,
          frameId: frameIdRef.current,
          qc,
        });
      } catch (err) {
        showToast(
          err instanceof Error ? err.message : "Couldn't copy annotations.",
          { variant: "error" },
        );
        return;
      }
      if (result.sourceTotal === 0) {
        showToast(`No annotations on "${sourceName}".`, { variant: "info" });
        return;
      }
      if (result.accepted.length === 0) {
        if (result.skippedByClass > 0 && result.skippedByGeometry === 0) {
          showToast(
            `0 copied — all ${result.skippedByClass} annotations use classes not in this task.`,
            { variant: "warning" },
          );
        } else if (
          result.skippedByGeometry > 0 &&
          result.skippedByClass === 0
        ) {
          showToast(
            `0 copied — ${result.skippedByGeometry} annotations had geometry incompatible with this image.`,
            { variant: "warning" },
          );
        } else {
          showToast(`Nothing valid to copy from "${sourceName}".`, {
            variant: "info",
          });
        }
        return;
      }
      useAnnotations.getState().addMany(result.accepted);
      const parts: string[] = [
        `Copied ${result.accepted.length} annotation${result.accepted.length === 1 ? "" : "s"}`,
        `from "${sourceName}"`,
      ];
      const tail: string[] = [];
      if (result.skippedByClass > 0)
        tail.push(`${result.skippedByClass} skipped (class)`);
      if (result.skippedByGeometry > 0)
        tail.push(`${result.skippedByGeometry} skipped (off-image)`);
      const msg =
        tail.length > 0
          ? `${parts.join(" ")} · ${tail.join(", ")}`
          : parts.join(" ") + ".";
      showToast(msg, { variant: "success" });
    },
    [
      assetQ.data?.asset,
      taskAssets,
      taskId,
      taskClassesQ.data?.allowed_class_ids,
      qc,
    ],
  );
```

- [ ] **Step 3: Register the `Shift+P` shortcut**

Below the existing `useShortcutHandler("copy_from_previous_asset", ...)` (around line 1336), add:

```ts
  useShortcutHandler("copy_from_any_asset", () => {
    setCopyPromptOpen(true);
  });
```

- [ ] **Step 4: Thread the `onContextMenuCopy` prop through `ThumbnailStripGate` to `AssetThumbnailStrip`**

Locate `ThumbnailStripGate` (defined as a small wrapper component in the same file, around line 158). Update its props interface and forward the new prop:

```tsx
interface ThumbnailStripGateProps {
  taskId: string;
  projectId: string;
  activeAssetId: string;
  onContextMenuCopy?: (
    assetId: string,
    pos: { x: number; y: number },
  ) => void;
}

function ThumbnailStripGate({
  taskId,
  projectId,
  activeAssetId,
  onContextMenuCopy,
}: ThumbnailStripGateProps) {
  const visible = useTool((s) => s.visibility.thumbnails);
  if (!visible) return null;
  return (
    <AssetThumbnailStrip
      taskId={taskId}
      projectId={projectId}
      activeAssetId={activeAssetId}
      onContextMenuCopy={onContextMenuCopy}
    />
  );
}
```

If the existing `ThumbnailStripGate` has additional props (bulk actions etc.), preserve them and add `onContextMenuCopy` alongside.

- [ ] **Step 5: Pass the callback at the `<ThumbnailStripGate />` mount site**

Find the existing `<ThumbnailStripGate ... />` JSX (around line 158) and add:

```tsx
            <ThumbnailStripGate
              taskId={taskId}
              projectId={projectId}
              activeAssetId={assetId}
              onContextMenuCopy={(sourceAssetId, pos) => {
                setThumbMenu({ sourceAssetId, x: pos.x, y: pos.y });
              }}
            />
```

- [ ] **Step 6: Mount the menu + both dialogs near `<KeyboardCheatSheet hideTrigger />`**

Find the existing `<KeyboardCheatSheet hideTrigger />` line (around line 2084). Add the new mounts immediately below it:

```tsx
              <KeyboardCheatSheet hideTrigger />

              {/* Arbitrary-source annotation copy — May 26 */}
              {thumbMenu && (
                <ThumbContextMenu
                  open
                  x={thumbMenu.x}
                  y={thumbMenu.y}
                  onClose={() => setThumbMenu(null)}
                  onCopy={() => {
                    setCopyDialogSourceId(thumbMenu.sourceAssetId);
                    setThumbMenu(null);
                  }}
                />
              )}

              <CopyFromPromptDialog
                open={copyPromptOpen}
                onOpenChange={setCopyPromptOpen}
                totalAssets={taskAssets.length}
                currentOrdinal={currentAssetIdx + 1}
                onPick={(ordinal) => {
                  const picked = taskAssets[ordinal - 1];
                  setCopyPromptOpen(false);
                  if (picked) {
                    setCopyDialogSourceId(picked.id);
                  }
                }}
              />

              <CopyAnnotationsDialog
                open={copyDialogSourceId !== null}
                onOpenChange={(o) => {
                  if (!o) setCopyDialogSourceId(null);
                }}
                sourceAsset={dialogSourceAsset}
                sourceOrdinal={dialogSourceOrdinal}
                totalAssets={taskAssets.length}
                targetAsset={assetQ.data?.asset ?? null}
                targetExistingCount={targetExistingCount}
                breakdown={copyDialogBreakdown}
                onConfirm={async () => {
                  if (!copyDialogSourceId) return;
                  const sourceId = copyDialogSourceId;
                  setCopyDialogSourceId(null);
                  await runCopyFromAsset(sourceId);
                }}
              />
```

- [ ] **Step 7: Type-check**

Run: `cd apps/web && pnpm tsc --noEmit --pretty false`
Expected: 0 errors.

Common fixes if errors appear:
- Add missing imports (`useMemo`, `useState`, `useQuery`, `annotationsApi`).
- If `useAnnotations` selector signature has changed since this plan was written, adjust the selector to match (`s.byAsset[assetId]?.length ?? 0` may need to be `s.byFrameId[frameId]?.length ?? 0` depending on actual store shape — check `apps/web/src/state/annotations.ts` for the current shape and pick the field that holds annotations keyed by the current asset).

- [ ] **Step 8: Run the full test suite (regression checkpoint)**

Run: `cd apps/web && pnpm vitest run`
Expected: all previously-passing tests still PASS, plus the new tests added in Tasks 2, 4, 5, 6.

- [ ] **Step 9: Commit**

```bash
cd /home/media4us/Documents/Dev/VisualAutoAnnotator
git add apps/web/src/pages/AnnotateAssetPage.tsx
git commit -m "feat(editor): wire arbitrary-source annotation copy (menu + Shift+P)"
```

---

## Task 9: Update KeyboardCheatSheet

**Files:**
- Modify: `apps/web/src/components/annotation/KeyboardCheatSheet.tsx`

- [ ] **Step 1: Add the new shortcut to the cheat sheet's token map**

Around line 175, where the `t` (tokens) object is built, add an entry below `copy_from_previous_asset`:

```ts
    copy_from_any_asset: chordTokens(useShortcut("copy_from_any_asset")),
```

- [ ] **Step 2: Add the new row to the Editor section**

Around line 278, where the Editor shortcuts are listed, add an entry directly after the `copy_from_previous_asset` row:

```ts
          { keys: t.copy_from_any_asset, desc: "Copy annotations from any asset (opens picker)" },
```

- [ ] **Step 3: Type-check + commit**

```bash
cd apps/web && pnpm tsc --noEmit --pretty false
cd /home/media4us/Documents/Dev/VisualAutoAnnotator
git add apps/web/src/components/annotation/KeyboardCheatSheet.tsx
git commit -m "docs(cheatsheet): list copy_from_any_asset shortcut"
```

---

## Task 10: Manual verification

**Goal:** confirm the feature works on a real task with real annotations before declaring it done.

- [ ] **Step 1: Start the web dev server**

Run: `cd apps/web && pnpm dev`
(Or, if the project uses Docker Compose, follow the project's existing dev-mode pattern.)

- [ ] **Step 2: Right-click flow verification**

In a browser:
1. Open the editor on a task with ≥ 20 image assets.
2. Annotate a few bboxes / polygons on asset #1.
3. Navigate to asset #15.
4. Right-click the thumbnail for asset #1 in the strip.
5. Confirm the context menu opens at the cursor with "Copy annotations to current asset".
6. Click it. Confirm the dialog opens with #1's thumbnail, filename, ordinal `1 / N`, breakdown (e.g. `3 bboxes · 1 polygon`), and `→ current asset: <asset-15>.png`.
7. Click `Copy 4 annotations`. Confirm:
   - The dialog closes.
   - A toast appears: `Copied 4 annotations from "<asset-1>.png".`
   - The canvas now shows the copied annotations.
   - `Cmd+Z` reverts them.

- [ ] **Step 3: Shift+P flow verification**

1. From asset #15 (still empty / cleared), press `Shift+P`.
2. Confirm the prompt opens with focus in the input.
3. Type `1`, press Enter. Confirm the confirm dialog opens identical to the right-click flow.
4. Click `Copy …`. Confirm the toast + canvas behaviour as above.

- [ ] **Step 4: Edge case — same-asset**

1. From asset #15, right-click asset #15's own thumbnail. Confirm the browser's default context menu appears (not ours) — i.e. the menu is suppressed on the active tile.
2. Press `Shift+P`, type `15`, press Enter. Confirm an inline error appears: `Same as current asset.`

- [ ] **Step 5: Edge case — empty source**

1. Pick any asset that has no annotations.
2. Either right-click its thumbnail or open `Shift+P` and enter its ordinal.
3. The dialog should show `Nothing to copy` and a single `Close` button (primary button labelled `Close`, not `Copy 0 …`).

- [ ] **Step 6: Edge case — video target**

1. Open the editor on a video asset.
2. Press `Shift+P`. The prompt should still open.
3. Type any valid ordinal and press Enter. Confirm a toast: `Copy annotations is image-only in v1 (video coming soon).`

- [ ] **Step 7: Regression — existing Ctrl+Shift+D still works**

1. Navigate to asset #2 (one after a previously-annotated #1).
2. Press `Ctrl+Shift+D` (or `Cmd+Shift+D` on macOS).
3. Confirm the existing toast `Copied N annotations from "<asset-1>.png"` appears with no dialog.

- [ ] **Step 8: Regression — thumbnail strip behaviour from May 26 fixes**

1. Sit on the editor for 11 minutes (or simulate by manually invalidating queries via DevTools).
2. Confirm thumbnails refresh (no broken-image icons).
3. Click rapidly across thumbnails — confirm the pending pulse + "Loading asset…" chip behave as in commit `69754ab`.
4. Run an auto-annotation job; on completion, confirm the strip refreshes and clicks load fresh data.

- [ ] **Step 9: Push**

If everything above passes:

```bash
git push origin master
```

---

## Rollback strategy

Each task is its own commit. If any task introduces a regression after Task 10's verification, `git revert <hash>` of that single commit unwinds it without affecting other tasks. Tasks 4-6 are pure new files and revert cleanly. Tasks 3 and 7-9 modify shared files; reverting Task 3 plus Tasks 7-9 returns the editor to its pre-feature state with `Ctrl+Shift+D` still working.

## Out of scope (deferred to v2)

- Multi-source copy (pick 2+ assets, union their annotations).
- Replace mode (clear current then copy).
- Video target / video source frame correspondence.
- Cross-task copy.
- Per-class or per-kind filter at copy time.
- Visual hover preview of the source's annotations overlaid on the strip tile.

These intentionally do not appear in this plan. Adding them would inflate the surface area and slow the v1 ship; the design is structured so each can be added later by extending the wrapper signature or adding fields to the dialog.
