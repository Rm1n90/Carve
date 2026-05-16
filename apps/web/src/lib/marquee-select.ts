// Armin Mehri — mehri.armin@gmail.com
/**
 * Marquee selection helpers.
 *
 * Pure intersection math for "drag-select rectangle in cursor mode".
 * The canvas owns the pointer state machine + the dashed-rect Pixi
 * graphic; this module is just the shape→rect intersect test and the
 * resulting id walk.
 *
 * Rule: AABB-intersect (any overlap counts). That's friendlier than
 * "fully contained" for messy data — CVAT users frequently miss the
 * tail of a long bbox with a contain-style marquee, then re-do the
 * drag, and we'd rather not make them do that.
 *
 * Spec ``docs/superpowers/specs/2026-05-16-annotator-accelerators-design.md`` F5.
 */
import type { AnnotationDraft, Geometry } from "@/state/annotations";

export interface ImageRect {
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
}

/**
 * Build the AABB of an annotation's geometry in image-space coords.
 * Returns null for shapes that have no spatial component (``tag``).
 *
 * mask_rle returns the raster's full bounds (``[0..w] × [0..h]``)
 * because we don't decode the RLE here — the canvas already paints
 * masks across their raster size, so this rough AABB matches what
 * the user "sees" of the mask. Tight mask bounds would mean decoding
 * the RLE on every marquee pixel-move, which is too expensive for
 * the interactive path.
 */
export function geometryAabb(geom: Geometry): ImageRect | null {
  if (geom.kind === "bbox") {
    return { x1: geom.x, y1: geom.y, x2: geom.x + geom.w, y2: geom.y + geom.h };
  }
  if (geom.kind === "polygon" && geom.points.length > 0) {
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    for (const [px, py] of geom.points) {
      if (px < x1) x1 = px;
      if (py < y1) y1 = py;
      if (px > x2) x2 = px;
      if (py > y2) y2 = py;
    }
    return { x1, y1, x2, y2 };
  }
  if (geom.kind === "mask_rle") {
    const [maskH, maskW] = geom.size;
    return { x1: 0, y1: 0, x2: maskW, y2: maskH };
  }
  return null;
}

/**
 * Normalise a (possibly-reversed) drag rectangle to the canonical
 * x1 <= x2, y1 <= y2 form.
 */
export function normaliseRect(
  a: { x: number; y: number },
  b: { x: number; y: number },
): ImageRect {
  return {
    x1: Math.min(a.x, b.x),
    y1: Math.min(a.y, b.y),
    x2: Math.max(a.x, b.x),
    y2: Math.max(a.y, b.y),
  };
}

/**
 * AABB-intersect test. Touching edges count as a hit (>= / <=) so a
 * marquee dragged exactly along an annotation's edge still picks it
 * up — the user's intent in that case is "include the things on this
 * row", not "exclude them on a sub-pixel technicality".
 */
export function rectIntersects(a: ImageRect, b: ImageRect): boolean {
  if (a.x2 < b.x1) return false;
  if (a.x1 > b.x2) return false;
  if (a.y2 < b.y1) return false;
  if (a.y1 > b.y2) return false;
  return true;
}

export interface MarqueeFilter {
  readonly hiddenAnnIds: ReadonlySet<string>;
  readonly hiddenClassIds: ReadonlySet<string>;
  readonly frameId: string | null;
}

/**
 * Return the tempIds of every annotation whose geometry AABB
 * intersects ``rect``. Filters out hidden / class-hidden /
 * wrong-frame annotations before testing.
 */
export function marqueeHits(
  rect: ImageRect,
  drafts: ReadonlyArray<AnnotationDraft>,
  filter: MarqueeFilter,
): string[] {
  const out: string[] = [];
  for (const d of drafts) {
    if (d.frameId !== filter.frameId) continue;
    if (filter.hiddenAnnIds.has(d.tempId)) continue;
    if (filter.hiddenClassIds.has(d.classId)) continue;
    const aabb = geometryAabb(d.geometry);
    if (!aabb) continue;
    if (rectIntersects(rect, aabb)) {
      out.push(d.tempId);
    }
  }
  return out;
}

export type SelectionMutation = "replace" | "add" | "remove";

/**
 * Apply ``hits`` to a current selection per the modifier rule.
 *   * ``replace`` — selection becomes exactly ``hits``.
 *   * ``add`` — union with current selection.
 *   * ``remove`` — subtract ``hits`` from current selection.
 *
 * Returned ids preserve insertion order: prior selection first (for
 * stable diffing in the canvas), then any newly-added ids.
 */
export function applyMarqueeMutation(
  current: ReadonlyArray<string>,
  hits: ReadonlyArray<string>,
  mode: SelectionMutation,
): string[] {
  if (mode === "replace") return [...hits];
  const currentSet = new Set(current);
  const hitsSet = new Set(hits);
  if (mode === "add") {
    const out = [...current];
    for (const h of hits) {
      if (!currentSet.has(h)) out.push(h);
    }
    return out;
  }
  return current.filter((id) => !hitsSet.has(id));
}
