// Armin Mehri — mehri.armin@gmail.com
//
// Selection-aware bulk Convert ▸ BBox helper. Shared between the
// right-click context menu and the `C` keyboard shortcut so both code
// paths agree on what "selected" means and produce matching toasts.
import { useAnnotations, type Geometry } from "@/state/annotations";
import { bboxOfGeometry, buildPolygon } from "@/lib/geometryConvert";
import { MERGED, samBoxesToShapes, samModeForClass, type SamShape } from "@/lib/samConvert";
import { showToast } from "@/lib/toast";
import { annotationsApi, type AnnotationRaw } from "@/api/annotations";

export interface BulkConvertResult {
  converted: number;
  skipped: number;
}

/**
 * Convert every currently-selected polygon / mask annotation into a
 * bbox. When ``ids`` is provided it overrides the live selection — the
 * context menu uses this when the right-clicked annotation is not part
 * of an existing multi-selection. Empty selections become a no-op
 * (the caller decides whether to show feedback).
 */
export function bulkConvertSelectedToBbox(
  ids?: ReadonlyArray<string>,
): BulkConvertResult {
  const targets =
    ids && ids.length > 0 ? ids : useAnnotations.getState().selectedIds;
  let converted = 0;
  let skipped = 0;
  for (const id of targets) {
    const cur = useAnnotations.getState().byId[id];
    if (!cur) {
      skipped++;
      continue;
    }
    const box = bboxOfGeometry(cur.geometry);
    if (!box || box.w < 1 || box.h < 1) {
      skipped++;
      continue;
    }
    useAnnotations.getState().update(id, {
      geometry: box,
      kind: "bbox",
      dirty: true,
    });
    converted++;
  }
  return { converted, skipped };
}

/**
 * Convenience wrapper that surfaces the standard success / error toast
 * matching the previous in-menu wording. Returns the same numbers so
 * callers that need to react further (e.g. close a menu) still can.
 */
export function bulkConvertSelectedToBboxWithToast(
  ids?: ReadonlyArray<string>,
): BulkConvertResult {
  const { converted, skipped } = bulkConvertSelectedToBbox(ids);
  if (converted > 0) {
    showToast(
      `Converted ${converted} ${converted === 1 ? "annotation" : "annotations"} to bbox${skipped > 0 ? ` (${skipped} skipped)` : ""}.`,
      { variant: "success" },
    );
  } else {
    showToast("No annotation could be converted to a bbox.", {
      variant: "error",
    });
  }
  return { converted, skipped };
}

/**
 * Count the polygon annotations on a given frame currently held in the
 * annotations store. Used by the editor toolbar's Convert button to
 * decide whether to enable / disable the "Convert on this image" menu
 * item without spinning up a subscription.
 */
export function countPolygonsOnFrame(frameId: string | null): number {
  let n = 0;
  for (const a of Object.values(useAnnotations.getState().byId)) {
    if (a.kind === "polygon" && a.frameId === frameId) n++;
  }
  return n;
}

/**
 * Convert every polygon currently on ``frameId`` to its enclosing
 * bounding box, locally in the store. Autosave picks up the resulting
 * dirty drafts and persists them. Mirrors the per-annotation path used
 * by the right-click "Convert ▸ BBox" submenu.
 */
export function bulkConvertPolygonsOnFrameToBboxWithToast(
  frameId: string | null,
): BulkConvertResult {
  const ids: string[] = [];
  for (const a of Object.values(useAnnotations.getState().byId)) {
    if (a.kind === "polygon" && a.frameId === frameId) ids.push(a.tempId);
  }
  if (ids.length === 0) {
    showToast("No polygons on this image.", { variant: "info" });
    return { converted: 0, skipped: 0 };
  }
  return bulkConvertSelectedToBboxWithToast(ids);
}

/**
 * v3.31 — task-wide CLEAR. Wipes every annotation on every asset in
 * the task in a single batch delete, then mirrors the result into the
 * local store so any annotations currently open in the editor
 * disappear without waiting for a query refetch. Mirrors the
 * ``bulkConvertPolygonsInTaskToBboxWithToast`` flow so the caller
 * gets a uniform ``BulkConvertResult`` shape (``converted`` here
 * doubles as "deleted").
 *
 * The caller already prompted the user with a count-aware
 * confirmation dialog; this helper does NOT confirm again.
 */
export async function bulkClearTaskAnnotationsWithToast(
  taskId: string,
  rawAnnotations: ReadonlyArray<AnnotationRaw>,
  /** Where the cleared annotations lived, used purely for toast
   *  wording. Defaults to "the task" (the all-assets path); the range
   *  path passes "the selected range". */
  scopeNoun = "the task",
): Promise<BulkConvertResult> {
  const ids = rawAnnotations.map((a) => a.id);
  if (ids.length === 0) {
    showToast(`No annotations to clear in ${scopeNoun}.`, { variant: "info" });
    return { converted: 0, skipped: 0 };
  }
  try {
    await annotationsApi.batch(taskId, {
      create: [],
      update: [],
      delete: ids,
    });
    // Local store sync — drop every draft whose serverId was in the
    // deleted set. Non-server (unsaved) drafts on the current asset
    // are kept intact; the AnnotateAssetPage gates this action on
    // ``dirtyCount > 0`` so in practice the local store already
    // reflects only server-known rows.
    const deletedSet = new Set(ids);
    const state = useAnnotations.getState();
    const toRemove: string[] = [];
    for (const draft of Object.values(state.byId)) {
      if (draft.serverId && deletedSet.has(draft.serverId)) {
        toRemove.push(draft.tempId);
      }
    }
    if (toRemove.length > 0) state.removeMany(toRemove);
    showToast(
      `Cleared ${ids.length} annotation${ids.length === 1 ? "" : "s"} across ${scopeNoun}.`,
      { variant: "success" },
    );
    return { converted: ids.length, skipped: 0 };
  } catch {
    showToast("Failed to clear annotations. Check your connection.", {
      variant: "error",
    });
    return { converted: 0, skipped: ids.length };
  }
}

/**
 * Task-wide polygon → bbox conversion. The caller is expected to have
 * already fetched the task's annotations (so the confirm dialog can
 * surface the exact count). The helper:
 *
 *   1. Computes the enclosing bbox for each polygon and drops any that
 *      collapse to <1px (degenerate point/line geometry).
 *   2. Sends a single batch update through ``annotationsApi.batch``.
 *   3. Mirrors the server's response into the local store so any
 *      annotations open in the current asset reflect the new state
 *      without waiting for a query refetch.
 *
 * Returns the same ``BulkConvertResult`` shape as the selection
 * helpers so the caller can react (close menu, show extra toast, etc.).
 */
export async function bulkConvertPolygonsInTaskToBboxWithToast(
  taskId: string,
  polygons: ReadonlyArray<AnnotationRaw>,
): Promise<BulkConvertResult> {
  let skipped = 0;
  const updates = polygons.flatMap((a) => {
    const box = bboxOfGeometry(a.geometry as unknown as Geometry);
    if (!box || box.w < 1 || box.h < 1) {
      skipped++;
      return [];
    }
    return [
      {
        id: a.id,
        kind: "bbox" as const,
        geometry: box as unknown as Record<string, unknown>,
      },
    ];
  });

  if (updates.length === 0) {
    showToast("No convertible polygons found.", { variant: "info" });
    return { converted: 0, skipped };
  }

  try {
    const out = await annotationsApi.batch(taskId, {
      create: [],
      update: updates,
      delete: [],
    });
    // Local store sync — only entries currently mounted in the open
    // asset have a ``serverId``; the rest live on disk only and will
    // refresh whenever the user navigates to them.
    const byServerId = new Map(out.updated.map((a) => [a.id, a]));
    const state = useAnnotations.getState();
    for (const draft of Object.values(state.byId)) {
      if (!draft.serverId) continue;
      const upd = byServerId.get(draft.serverId);
      if (!upd) continue;
      state.update(draft.tempId, {
        kind: upd.kind,
        geometry: upd.geometry as unknown as Geometry,
        dirty: false,
      });
    }
    const converted = updates.length;
    showToast(
      `Converted ${converted} ${converted === 1 ? "polygon" : "polygons"} to bbox${
        skipped > 0 ? ` (${skipped} skipped)` : ""
      }.`,
      { variant: "success" },
    );
    return { converted, skipped };
  } catch {
    showToast("Failed to convert polygons. Check your connection.", {
      variant: "error",
    });
    return { converted: 0, skipped: polygons.length };
  }
}

// ---------------------------------------------------------------------------
// Box -> polygon (SAM)
// ---------------------------------------------------------------------------

/** A SAM result as an annotation's kind and geometry. */
function shapeOf(g: SamShape | undefined): { kind: "polygon" | "mask"; geometry: Geometry } | null {
  if (!g || g === MERGED) return null;
  if (g.kind === "mask_rle") return { kind: "mask", geometry: g };
  if (g.kind === "polygon") {
    const poly = buildPolygon(g.points);
    return poly ? { kind: "polygon", geometry: poly } : null;
  }
  return null;
}

function xyxyOf(geometry: Geometry): [number, number, number, number] | null {
  const box = bboxOfGeometry(geometry);
  if (!box || box.w < 1 || box.h < 1) return null;
  return [box.x, box.y, box.x + box.w, box.y + box.h];
}

/** Bounding boxes on ``frameId`` held in the annotations store. */
export function countBoxesOnFrame(frameId: string | null): number {
  let n = 0;
  for (const a of Object.values(useAnnotations.getState().byId)) {
    if (a.kind === "bbox" && a.frameId === frameId) n++;
  }
  return n;
}

/**
 * Turn every bounding box on the open image into a SAM polygon, locally
 * in the store (undoable; autosave persists it). All boxes go to the
 * server in one call.
 */
export async function bulkConvertBoxesOnFrameToPolygonsWithToast(
  assetId: string,
  frameId: string | null,
  classNameById: Readonly<Record<string, string>> = {},
): Promise<BulkConvertResult> {
  const targets = Object.values(useAnnotations.getState().byId).filter(
    (a) => a.kind === "bbox" && a.frameId === frameId,
  );
  const withBox = targets
    .map((a) => ({ id: a.tempId, box: xyxyOf(a.geometry), mode: samModeForClass(classNameById[a.classId]) }))
    .filter(
      (t): t is { id: string; box: [number, number, number, number]; mode: ReturnType<typeof samModeForClass> } =>
        t.box !== null,
    );
  if (withBox.length === 0) {
    showToast("No boxes on this image.", { variant: "info" });
    return { converted: 0, skipped: targets.length };
  }
  window.dispatchEvent(new CustomEvent("carve:cancel-drag"));
  let shapes: SamShape[];
  try {
    shapes = await samBoxesToShapes({
      assetId,
      frameId,
      boxes: withBox.map((t) => t.box),
      modes: withBox.map((t) => t.mode),
    });
  } catch (err) {
    const e = err as { response?: { data?: { detail?: string } }; message?: string };
    showToast(`SAM conversion failed: ${e?.response?.data?.detail ?? e?.message ?? "request failed"}`, {
      variant: "error",
    });
    return { converted: 0, skipped: targets.length };
  }
  let converted = 0;
  let skipped = targets.length - withBox.length;
  // Crowd boxes joined into a touching one: that one now covers them.
  const merged = withBox.filter((t, i) => shapes[i] === MERGED).map((t) => t.id);
  if (merged.length > 0) useAnnotations.getState().removeMany(merged);
  withBox.forEach((t, i) => {
    if (shapes[i] === MERGED) {
      converted++;
      return;
    }
    const shape = shapeOf(shapes[i]);
    if (!shape || !useAnnotations.getState().byId[t.id]) {
      skipped++;
      return;
    }
    useAnnotations.getState().update(t.id, { kind: shape.kind, geometry: shape.geometry, dirty: true });
    converted++;
  });
  showToast(
    converted > 0
      ? `Converted ${converted} box${converted === 1 ? "" : "es"} to polygons${skipped > 0 ? ` (${skipped} left as boxes: SAM found nothing)` : ""}.`
      : "SAM found no object in any of the boxes.",
    { variant: converted > 0 ? "success" : "error" },
  );
  return { converted, skipped };
}

export interface TaskConvertProgress {
  doneImages: number;
  totalImages: number;
  converted: number;
  failedImages: number;
}

/**
 * Task-wide box -> polygon. Goes image by image: one SAM call per image
 * for all its boxes, then one batch save, so an interruption loses at
 * most the image in progress and everything before it is saved.
 * ``signal`` stops it between images.
 */
export async function bulkConvertBoxesInTaskToPolygons(
  taskId: string,
  boxes: ReadonlyArray<AnnotationRaw>,
  {
    signal,
    onProgress,
    classNameById = {},
  }: {
    signal?: AbortSignal;
    onProgress?: (p: TaskConvertProgress) => void;
    classNameById?: Readonly<Record<string, string>>;
  } = {},
): Promise<TaskConvertProgress & { skipped: number; canceled: boolean }> {
  const groups = new Map<string, { assetId: string; frameId: string | null; items: AnnotationRaw[] }>();
  for (const a of boxes) {
    if (a.kind !== "bbox" || !a.asset_id) continue;
    const key = `${a.asset_id}|${a.frame_id ?? ""}`;
    const g = groups.get(key) ?? { assetId: a.asset_id, frameId: a.frame_id, items: [] };
    g.items.push(a);
    groups.set(key, g);
  }
  const progress: TaskConvertProgress = {
    doneImages: 0,
    totalImages: groups.size,
    converted: 0,
    failedImages: 0,
  };
  let skipped = 0;
  onProgress?.({ ...progress });
  for (const g of groups.values()) {
    if (signal?.aborted) return { ...progress, skipped, canceled: true };
    const usable = g.items
      .map((a) => ({ a, box: xyxyOf(a.geometry as unknown as Geometry) }))
      .filter((t): t is { a: AnnotationRaw; box: [number, number, number, number] } => t.box !== null);
    skipped += g.items.length - usable.length;
    try {
      const shapes = await samBoxesToShapes({
        assetId: g.assetId,
        frameId: g.frameId,
        boxes: usable.map((t) => t.box),
        modes: usable.map((t) => samModeForClass(classNameById[t.a.class_id])),
        signal,
      });
      const merged = usable.filter((t, i) => shapes[i] === MERGED).map((t) => t.a.id);
      const updates = usable.flatMap((t, i) => {
        if (shapes[i] === MERGED) return [];
        const shape = shapeOf(shapes[i]);
        if (!shape) {
          skipped++;
          return [];
        }
        return [{ id: t.a.id, kind: shape.kind, geometry: shape.geometry as unknown as Record<string, unknown> }];
      });
      if (updates.length > 0 || merged.length > 0) {
        const out = await annotationsApi.batch(taskId, { create: [], update: updates, delete: merged });
        const byServerId = new Map(out.updated.map((a) => [a.id, a]));
        const state = useAnnotations.getState();
        for (const draft of Object.values(state.byId)) {
          const upd = draft.serverId ? byServerId.get(draft.serverId) : undefined;
          if (upd) {
            state.update(draft.tempId, {
              kind: upd.kind,
              geometry: upd.geometry as unknown as Geometry,
              dirty: false,
            });
          }
        }
        const gone = new Set(merged);
        const stale = Object.values(state.byId)
          .filter((d) => d.serverId && gone.has(d.serverId))
          .map((d) => d.tempId);
        if (stale.length > 0) state.removeMany(stale);
        progress.converted += updates.length + merged.length;
      }
    } catch {
      if (signal?.aborted) return { ...progress, skipped, canceled: true };
      progress.failedImages++;
    }
    progress.doneImages++;
    onProgress?.({ ...progress });
  }
  return { ...progress, skipped, canceled: false };
}
