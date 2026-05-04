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
import { annotationsApi } from "@/api/annotations";

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
  /** Plan-19 — diagnostic breakdown of *why* rows were skipped. Populated
   *  by ``runBatchTaskPostProcess``; the single-asset helper still
   *  returns just the totals. */
  skipReasons?: Record<string, number>;
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

export interface BatchTaskPostProcessParams {
  taskId: string;
  /** Only annotations created at/after this ISO timestamp are eligible.
   *  Used to scope the post-process to rows the just-finished batch run
   *  produced (Auto-Annotate / Predict capture this when they fire). */
  sinceIso: string;
  /** Optional class-id allowlist — typically the classes the batch run
   *  targeted, so older rows of the same kind aren't touched. */
  classIds?: ReadonlySet<string>;
  mode: PostProcessMode;
  imageBoundsByAsset?: ReadonlyMap<string, { w: number; h: number }>;
  onProgress?: (p: PostProcessProgress) => void;
  signal?: AbortSignal;
}

/**
 * Plan-19 — batch post-process across an entire task.
 *
 * Used by Auto-Annotate (scope=all) and YOLO Predict (scope=task) to
 * apply the same kind-conversion / refine pass that was previously
 * single-asset-only.
 *
 * For ``to-bbox`` we never call SAM — bbox is the polygon's axis-aligned
 * envelope, so the work batches into a single ``annotations:batch``
 * server round-trip per chunk of rows.
 *
 * For ``to-polygon`` / ``refine`` SAM is required per-asset (the model
 * encodes one image at a time). Rows are grouped by ``asset_id`` and
 * processed asset-by-asset so the encoder warms once per group.
 * Successful conversions persist via individual PATCH calls because
 * SAM responses arrive interleaved.
 */
export async function runBatchTaskPostProcess(
  params: BatchTaskPostProcessParams,
): Promise<PostProcessResult> {
  const {
    taskId,
    sinceIso,
    classIds,
    mode,
    imageBoundsByAsset,
    onProgress,
    signal,
  } = params;

  // Fetch every annotation on the task, then narrow client-side. The
  // batch run window is usually small enough that a server-side filter
  // would save little — and the existing list endpoint is the only
  // task-wide source of truth.
  const all = await annotationsApi.listForTaskRaw(taskId);
  const since = new Date(sinceIso).getTime();
  const inputKinds: ReadonlySet<string> =
    mode === "to-bbox"
      ? new Set(["polygon", "mask_rle", "mask"])
      : mode === "to-polygon"
        ? new Set(["bbox"])
        : new Set(["polygon", "mask_rle", "mask"]);
  const candidates = all.filter((a) => {
    if (!inputKinds.has(a.kind)) return false;
    if (classIds && !classIds.has(a.class_id)) return false;
    const t = new Date(a.created_at).getTime();
    if (Number.isFinite(t) && t < since - 1000) return false;
    return true;
  });

  const total = candidates.length;
  let succeeded = 0;
  let failed = 0;
  let cancelled = false;
  onProgress?.({ done: 0, total, failed: 0 });

  if (total === 0) {
    return { succeeded: 0, failed: 0, cancelled: false };
  }

  if (mode === "to-bbox") {
    // Pure client conversion — chunk the patches so a 5000-row task
    // doesn't post a single megabyte payload.
    const CHUNK = 200;
    for (let i = 0; i < candidates.length; i += CHUNK) {
      if (signal?.aborted) {
        cancelled = true;
        break;
      }
      const slice = candidates.slice(i, i + CHUNK);
      const updates: Array<{
        id: string;
        kind: "bbox";
        geometry: { x: number; y: number; w: number; h: number };
      }> = [];
      for (const a of slice) {
        const box = bboxOfGeometry(a.geometry as never);
        if (box && box.w >= 1 && box.h >= 1) {
          updates.push({ id: a.id, kind: "bbox", geometry: box });
        } else {
          failed++;
        }
      }
      if (updates.length > 0) {
        try {
          await annotationsApi.batch(taskId, {
            create: [],
            update: updates,
            delete: [],
          });
          succeeded += updates.length;
        } catch {
          failed += updates.length;
        }
      }
      onProgress?.({ done: Math.min(i + slice.length, total), total, failed });
    }
    return { succeeded, failed, cancelled };
  }

  // SAM-required modes. Group by asset so the model encodes once per
  // image; within a group iterate sequentially.
  const skipReasons: Record<string, number> = {};
  const bumpReason = (reason: string) => {
    skipReasons[reason] = (skipReasons[reason] ?? 0) + 1;
  };
  const byAsset = new Map<string, typeof candidates>();
  for (const a of candidates) {
    if (!a.asset_id) {
      failed++;
      bumpReason("no_asset_id");
      continue;
    }
    const list = byAsset.get(a.asset_id) ?? [];
    list.push(a);
    byAsset.set(a.asset_id, list);
  }

  let processed = 0;
  for (const [assetId, group] of byAsset) {
    if (signal?.aborted) {
      cancelled = true;
      break;
    }
    const bounds = imageBoundsByAsset?.get(assetId);
    const updates: Array<{
      id: string;
      kind: "polygon";
      geometry: { points: [number, number][] };
    }> = [];
    for (const ann of group) {
      if (signal?.aborted) {
        cancelled = true;
        break;
      }
      try {
        const points = await samPolygonForGeometry({
          assetId,
          frameId: ann.frame_id,
          geometry: ann.geometry as never,
        });
        if (!points) {
          // samPolygonForGeometry returns null when the bbox is < 1px
          // OR the SAM decode response had no polygon. We can't tell
          // the two apart from out here — bucket as "sam_no_polygon".
          failed++;
          bumpReason("sam_no_polygon");
        } else if (points.length < 3) {
          failed++;
          bumpReason("polygon_too_few_points");
        } else {
          const clamped = bounds
            ? points.map(
                ([x, y]) =>
                  [
                    Math.max(0, Math.min(bounds.w, x)),
                    Math.max(0, Math.min(bounds.h, y)),
                  ] as [number, number],
              )
            : points;
          const poly = buildPolygon(clamped);
          if (poly) {
            updates.push({ id: ann.id, kind: "polygon", geometry: poly });
          } else {
            failed++;
            bumpReason("degenerate_after_clamp");
          }
        }
      } catch {
        failed++;
        bumpReason("sam_call_failed");
      }
      processed++;
      onProgress?.({ done: processed, total, failed });
    }
    if (updates.length > 0) {
      try {
        await annotationsApi.batch(taskId, {
          create: [],
          update: updates,
          delete: [],
        });
        succeeded += updates.length;
      } catch {
        failed += updates.length;
        skipReasons.persist_batch_failed =
          (skipReasons.persist_batch_failed ?? 0) + updates.length;
      }
    }
  }
  if (failed > 0) {
    // Surface the breakdown in the console so power users can inspect
    // why SAM didn't produce polygons for these rows.
    // eslint-disable-next-line no-console
    console.info(
      "[runBatchTaskPostProcess] skipped breakdown:",
      skipReasons,
      `succeeded=${succeeded} failed=${failed}`,
    );
  }
  return { succeeded, failed, cancelled, skipReasons };
}
