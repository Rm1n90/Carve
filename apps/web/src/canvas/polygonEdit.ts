/**
 * Pure math + utilities for polygon vertex editing.
 *
 * Lives separately from AnnotationCanvas so it can be unit-tested without
 * instantiating Pixi. Phase A core 3.
 *
 * The polygon's points are stored as `[number, number][]` in image-space.
 * Each handle has a fixed visual radius for hit-testing.
 */
import type { Polygon } from "@/state/annotations";

/** Pixel-radius hit-test halo around each vertex handle. */
export const POLY_VERTEX_HIT_HALO = 6;
/** Visual size (px) of each vertex handle (square). */
export const POLY_VERTEX_HANDLE_PX = 8;
/** Minimum polygon vertex count after a delete. */
export const POLY_MIN_VERTICES = 3;

/**
 * Hit-test against a polygon's vertices. Returns the index of the matching
 * vertex (within ``POLY_VERTEX_HIT_HALO`` of the cursor) or null.
 */
export function hitTestVertex(
  poly: Polygon,
  cursor: { x: number; y: number },
): number | null {
  for (let i = 0; i < poly.points.length; i++) {
    const [vx, vy] = poly.points[i];
    if (
      Math.abs(cursor.x - vx) <= POLY_VERTEX_HIT_HALO &&
      Math.abs(cursor.y - vy) <= POLY_VERTEX_HIT_HALO
    ) {
      return i;
    }
  }
  return null;
}

/** Returns a new polygon with the vertex at ``index`` moved to ``cursor``.
 *  Pure: original polygon is not mutated. */
export function applyVertexTranslate(
  original: Polygon,
  index: number,
  cursor: { x: number; y: number },
): Polygon {
  if (index < 0 || index >= original.points.length) return original;
  const next = original.points.map((pt, i) =>
    i === index ? ([cursor.x, cursor.y] as [number, number]) : pt,
  );
  return { kind: "polygon", points: next };
}

/** Returns a new polygon with the vertex at ``index`` removed. Returns the
 *  original unchanged if removing would leave fewer than 3 vertices. */
export function applyVertexDelete(
  original: Polygon,
  index: number,
): Polygon {
  if (original.points.length <= POLY_MIN_VERTICES) return original;
  if (index < 0 || index >= original.points.length) return original;
  const next = original.points.filter((_, i) => i !== index);
  return { kind: "polygon", points: next };
}
