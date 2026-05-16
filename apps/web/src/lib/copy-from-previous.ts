// Armin Mehri — mehri.armin@gmail.com
/**
 * Copy-from-previous-asset helper.
 *
 * Pure function that takes the annotations from a previous asset and
 * returns fresh ``AnnotationDraft`` rows ready to be added to the
 * current asset's store. The caller is responsible for:
 *   - converting from server / raw API shape into ``AnnotationDraft``,
 *   - calling ``useAnnotations.add()`` on each accepted entry,
 *   - showing the result toast.
 *
 * Why a pure helper: the call site does the React Query + store wiring,
 * but the geometry-clamping, class-subset filtering, fresh-tempId
 * generation, and "drop degenerate" logic all benefit from being
 * exercised in unit tests without dragging a DOM in.
 *
 * Contract (per spec ``docs/superpowers/specs/2026-05-16-annotator-accelerators-design.md``):
 *   * Each accepted draft gets a fresh tempId, ``serverId: null``,
 *     ``dirty: true`` so autosave POSTs it as a new row.
 *   * Status / review fields are RESET to a clean "proposed" baseline:
 *     a copied annotation is functionally a new annotation in the
 *     target asset and must go through QA independently.
 *   * ``trackId`` is reset to null — tracks are per-asset; preserving
 *     a track id across assets would corrupt the tracking semantics.
 *   * Geometry is clamped to ``targetImageSize`` (when supplied) and
 *     dropped if the clamp collapses it below the minimum edge.
 */
import type {
  AnnotationDraft,
  Geometry,
} from "@/state/annotations";

/** Minimum bbox edge size (image-space px). Mirrors BboxTool's MIN_BBOX_SIZE. */
const MIN_BBOX_EDGE_PX = 4;

/** Minimum unique polygon vertex count for a non-degenerate shape. */
const MIN_POLYGON_VERTICES = 3;

export interface ImageSize {
  readonly w: number;
  readonly h: number;
}

/**
 * Source draft shape — only the fields we copy forward are required.
 * Letting the caller pass a ``Partial<AnnotationDraft>`` keeps the
 * helper usable from anywhere — raw API row conversion or store
 * snapshot alike.
 */
export type CopySource = Pick<
  AnnotationDraft,
  "classId" | "kind" | "geometry"
> & Partial<Pick<AnnotationDraft, "zOrder" | "colorOverride">>;

export interface CopyOptions {
  /** Image dimensions of the *target* asset. ``null`` skips clamping. */
  readonly targetImageSize: ImageSize | null;
  /**
   * Whitelist of class ids legal in the target task. ``null`` means
   * "no subset restriction — accept any class". Use ``new Set()`` to
   * reject everything (rare but valid).
   */
  readonly allowedClassIds: ReadonlySet<string> | null;
  /** ``frameId`` to attach to the copied drafts. */
  readonly targetFrameId: string | null;
  /** Fresh-tempId generator; pass a deterministic one in tests. */
  readonly genTempId: () => string;
}

export interface CopyResult {
  /** Fresh drafts ready for ``useAnnotations.add()``. */
  readonly accepted: AnnotationDraft[];
  /** How many sources were dropped because their class is not allowed. */
  readonly skippedByClass: number;
  /** How many sources were dropped because geometry collapsed. */
  readonly skippedByGeometry: number;
}

function clamp(value: number, lo: number, hi: number): number {
  if (value < lo) return lo;
  if (value > hi) return hi;
  return value;
}

function clampBbox(
  geom: Extract<Geometry, { kind: "bbox" }>,
  size: ImageSize,
): Geometry | null {
  const x1 = clamp(geom.x, 0, size.w);
  const y1 = clamp(geom.y, 0, size.h);
  const x2 = clamp(geom.x + geom.w, 0, size.w);
  const y2 = clamp(geom.y + geom.h, 0, size.h);
  const w = x2 - x1;
  const h = y2 - y1;
  if (w < MIN_BBOX_EDGE_PX || h < MIN_BBOX_EDGE_PX) return null;
  return { kind: "bbox", x: x1, y: y1, w, h };
}

function clampPolygon(
  geom: Extract<Geometry, { kind: "polygon" }>,
  size: ImageSize,
): Geometry | null {
  if (!Array.isArray(geom.points) || geom.points.length === 0) return null;
  const clamped: [number, number][] = [];
  let lastX: number | null = null;
  let lastY: number | null = null;
  for (const [px, py] of geom.points) {
    const cx = clamp(px, 0, size.w);
    const cy = clamp(py, 0, size.h);
    // Drop adjacent duplicates introduced by the clamp (e.g. multiple
    // off-image vertices all snapping to the same corner).
    if (cx === lastX && cy === lastY) continue;
    clamped.push([cx, cy]);
    lastX = cx;
    lastY = cy;
  }
  // Also fold the first / last duplication that polygon producers
  // sometimes emit, so the unique-vertex count is honest.
  if (
    clamped.length > 1 &&
    clamped[0][0] === clamped[clamped.length - 1][0] &&
    clamped[0][1] === clamped[clamped.length - 1][1]
  ) {
    clamped.pop();
  }
  if (clamped.length < MIN_POLYGON_VERTICES) return null;
  return { kind: "polygon", points: clamped };
}

/**
 * Clamp the geometry to the target image. Returns null when the
 * clamp leaves nothing salvageable (degenerate / off-image / mask
 * resampling mismatch).
 *
 * Rules:
 *   * ``bbox`` — clamp corners, drop if any edge < MIN_BBOX_EDGE_PX.
 *   * ``polygon`` — clamp every vertex, drop adjacent duplicates and
 *     a closing-vertex-duplicate, then drop the whole shape if it
 *     no longer has at least 3 unique vertices.
 *   * ``mask_rle`` — RLE masks are tied to their source raster
 *     dimensions; if the target image is a different size the mask
 *     would have to be resampled. v1 declines and lets the caller
 *     decide (counted as ``skippedByGeometry``).
 *   * ``tag`` — geometry has no spatial component, copy as-is.
 */
function clampGeometry(
  geom: Geometry,
  size: ImageSize | null,
): Geometry | null {
  if (geom.kind === "tag") return geom;
  if (geom.kind === "bbox") {
    if (!size) {
      return geom.w >= MIN_BBOX_EDGE_PX && geom.h >= MIN_BBOX_EDGE_PX ? geom : null;
    }
    return clampBbox(geom, size);
  }
  if (geom.kind === "polygon") {
    if (!size) {
      return geom.points.length >= MIN_POLYGON_VERTICES ? geom : null;
    }
    return clampPolygon(geom, size);
  }
  if (geom.kind === "mask_rle") {
    if (!size) return geom; // caller takes the risk
    const [maskH, maskW] = geom.size;
    if (maskW !== size.w || maskH !== size.h) {
      // Mask raster size mismatch — v1 declines rather than resample.
      return null;
    }
    return geom;
  }
  return null;
}

/**
 * Produce a fresh ``AnnotationDraft`` array for the target asset.
 * Sources are filtered, clamped, and assigned new tempIds; counts of
 * sources dropped for class-subset / geometry reasons are returned so
 * the caller can surface a useful toast.
 */
export function copyAnnotationsToTarget(
  source: ReadonlyArray<CopySource>,
  opts: CopyOptions,
): CopyResult {
  const accepted: AnnotationDraft[] = [];
  let skippedByClass = 0;
  let skippedByGeometry = 0;

  for (const s of source) {
    if (
      opts.allowedClassIds !== null &&
      !opts.allowedClassIds.has(s.classId)
    ) {
      skippedByClass += 1;
      continue;
    }
    const geom = clampGeometry(s.geometry, opts.targetImageSize);
    if (!geom) {
      skippedByGeometry += 1;
      continue;
    }
    accepted.push({
      tempId: opts.genTempId(),
      classId: s.classId,
      kind: s.kind,
      geometry: geom,
      frameId: opts.targetFrameId,
      serverId: null,
      dirty: true,
      // Review state is intentionally reset — a copied annotation is
      // a brand-new annotation in the target asset and must go
      // through QA on its own.
      status: "proposed",
      reviewedById: null,
      reviewedAt: null,
      prevGeometry: null,
      // Track ids are per-asset; preserving them across assets would
      // corrupt tracking. Reset to null even if the source had one.
      trackId: null,
      zOrder: s.zOrder ?? 0,
      colorOverride: s.colorOverride ?? null,
    });
  }

  return { accepted, skippedByClass, skippedByGeometry };
}
