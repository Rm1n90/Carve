// Armin Mehri — mehri.armin@gmail.com
//
// Selection-aware bulk Convert ▸ BBox helper. Shared between the
// right-click context menu and the `C` keyboard shortcut so both code
// paths agree on what "selected" means and produce matching toasts.
import { useAnnotations, type Geometry } from "@/state/annotations";
import { bboxOfGeometry } from "@/lib/geometryConvert";
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
): Promise<BulkConvertResult> {
  const ids = rawAnnotations.map((a) => a.id);
  if (ids.length === 0) {
    showToast("No annotations to clear in this task.", { variant: "info" });
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
      `Cleared ${ids.length} annotation${ids.length === 1 ? "" : "s"} across the task.`,
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
