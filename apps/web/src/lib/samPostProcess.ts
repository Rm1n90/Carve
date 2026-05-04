// Armin Mehri — mehri.armin@gmail.com
//
// Plan-17 Phase 2 — batched post-processing helper.
//
// Used by the YOLO Predict and Auto-Annotate dialogs to run a SAM
// refinement / kind-conversion pass over a freshly-created batch of
// annotations on the current asset, reporting real-time progress.
//
// All operations preserve the original annotation when SAM fails for
// that row — only successful rows get rewritten in the store.
import { useAnnotations } from "@/state/annotations";
import {
  bboxOfGeometry,
  buildPolygon,
} from "@/lib/geometryConvert";
import { samPolygonForGeometry } from "@/lib/samConvert";

export type PostProcessMode =
  /** Replace each polygon / mask geometry with its axis-aligned bbox. Pure client. */
  | "to-bbox"
  /** Replace each bbox with a SAM polygon for the bbox region. */
  | "to-polygon"
  /** Refine each polygon / mask with SAM (uses its bbox as a box-prompt). */
  | "refine";

export interface PostProcessProgress {
  done: number;
  total: number;
  /** Increments alongside ``done`` whenever SAM produced no usable
   * polygon for that row; the original geometry is preserved. */
  failed: number;
}

export interface PostProcessParams {
  assetId: string;
  frameId?: string | null;
  annotationIds: readonly string[];
  mode: PostProcessMode;
  imageBounds?: { w: number; h: number };
  onProgress?: (p: PostProcessProgress) => void;
  /**
   * AbortSignal so the caller can cancel mid-batch (e.g. user closed
   * the dialog or hit Esc). The current row finishes — we never tear
   * down a request mid-flight — but no further rows are processed.
   */
  signal?: AbortSignal;
}

export interface PostProcessResult {
  succeeded: number;
  failed: number;
  cancelled: boolean;
}

/**
 * Run a sequential post-processing pass over a list of annotation IDs.
 *
 * Sequential rather than parallel because the SAM model service typically
 * holds the GPU mutex per call; firing N parallel box-prompts would just
 * queue them server-side and add no throughput while making the progress
 * bar misleading (all rows stuck at 0% until the queue drains).
 */
export async function runSamPostProcess(
  params: PostProcessParams,
): Promise<PostProcessResult> {
  const {
    assetId,
    frameId,
    annotationIds,
    mode,
    imageBounds,
    onProgress,
    signal,
  } = params;
  const total = annotationIds.length;
  let succeeded = 0;
  let failed = 0;
  let cancelled = false;
  onProgress?.({ done: 0, total, failed: 0 });
  for (let i = 0; i < annotationIds.length; i++) {
    if (signal?.aborted) {
      cancelled = true;
      break;
    }
    const id = annotationIds[i];
    const cur = useAnnotations.getState().byId[id];
    if (!cur) {
      failed++;
      onProgress?.({ done: i + 1, total, failed });
      continue;
    }
    try {
      if (mode === "to-bbox") {
        const box = bboxOfGeometry(cur.geometry);
        if (!box || box.w < 1 || box.h < 1) {
          failed++;
        } else {
          useAnnotations.getState().update(id, {
            geometry: box,
            kind: "bbox",
            dirty: true,
          });
          succeeded++;
        }
      } else {
        // to-polygon / refine — both use samPolygonForGeometry on the
        // annotation's existing bbox.
        const points = await samPolygonForGeometry({
          assetId,
          frameId,
          geometry: cur.geometry,
        });
        if (!points || points.length < 3) {
          failed++;
        } else {
          const clamped = imageBounds
            ? points.map(
                ([x, y]) =>
                  [
                    Math.max(0, Math.min(imageBounds.w, x)),
                    Math.max(0, Math.min(imageBounds.h, y)),
                  ] as [number, number],
              )
            : points;
          const poly = buildPolygon(clamped);
          if (!poly) {
            failed++;
          } else {
            useAnnotations.getState().update(id, {
              geometry: poly,
              kind: "polygon",
              dirty: true,
            });
            succeeded++;
          }
        }
      }
    } catch {
      failed++;
    }
    onProgress?.({ done: i + 1, total, failed });
  }
  return { succeeded, failed, cancelled };
}

/**
 * Snapshot helper — captures the set of annotation IDs currently in the
 * Zustand store so callers can diff against it later to find newly-created
 * rows. Used by the YOLO Predict + Auto-Annotate post-processing flows
 * which only want to operate on annotations the predict pass produced.
 */
export function snapshotAnnotationIds(): Set<string> {
  return new Set(Object.keys(useAnnotations.getState().byId));
}

/**
 * Diff helper — returns IDs in the store that are NOT in the snapshot
 * AND that match the optional ``frameId`` filter. ``frameId === null``
 * matches frame-less annotations (image tasks store annotations under
 * the asset's auto-frame).
 */
export function newAnnotationIdsSince(
  snapshot: ReadonlySet<string>,
  frameId?: string | null,
): string[] {
  const byId = useAnnotations.getState().byId;
  const out: string[] = [];
  for (const id of Object.keys(byId)) {
    if (snapshot.has(id)) continue;
    if (frameId !== undefined) {
      const draft = byId[id];
      if (draft && draft.frameId !== frameId) continue;
    }
    out.push(id);
  }
  return out;
}
