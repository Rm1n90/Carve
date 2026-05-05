// Armin Mehri — mehri.armin@gmail.com
//
// Selection-aware bulk Convert ▸ BBox helper. Shared between the
// right-click context menu and the `C` keyboard shortcut so both code
// paths agree on what "selected" means and produce matching toasts.
import { useAnnotations } from "@/state/annotations";
import { bboxOfGeometry } from "@/lib/geometryConvert";
import { showToast } from "@/lib/toast";

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
