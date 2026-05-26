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

  type RawAnnotationList = Awaited<
    ReturnType<typeof annotationsApi.listForTaskRaw>
  >;
  const cached = qc.getQueryData<RawAnnotationList>([
    "task-annotations-raw",
    taskId,
  ]);
  const raw: RawAnnotationList =
    cached ??
    (await qc.fetchQuery<RawAnnotationList>({
      queryKey: ["task-annotations-raw", taskId],
      queryFn: () => annotationsApi.listForTaskRaw(taskId),
    }));

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
