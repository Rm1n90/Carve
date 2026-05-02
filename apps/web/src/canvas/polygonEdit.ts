// Armin Mehri — mehri.armin@gmail.com
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
 * Image bounds used when clamping a moved vertex. Optional — when null
 * the helpers fall back to the legacy bound-agnostic behaviour. v2.5.2.
 */
export interface ImageBounds {
  w: number;
  h: number;
}

function clamp(value: number, lo: number, hi: number): number {
  if (value < lo) return lo;
  if (value > hi) return hi;
  return value;
}

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

/**
 * Returns a new polygon with the vertex at ``index`` moved to ``cursor``.
 * Pure: the original polygon is not mutated. When `bounds` is provided
 * the new vertex is clamped to `[0, bounds.w] x [0, bounds.h]` so it
 * cannot escape the image. v2.5.2.
 */
export function applyVertexTranslate(
  original: Polygon,
  index: number,
  cursor: { x: number; y: number },
  bounds: ImageBounds | null = null,
): Polygon {
  if (index < 0 || index >= original.points.length) return original;
  const cx = bounds ? clamp(cursor.x, 0, bounds.w) : cursor.x;
  const cy = bounds ? clamp(cursor.y, 0, bounds.h) : cursor.y;
  const next = original.points.map((pt, i) =>
    i === index ? ([cx, cy] as [number, number]) : pt,
  );
  return { kind: "polygon", points: next };
}

/**
 * Tolerance (image-space pixels) for hit-testing a polygon edge. Mirrors
 * ``POLY_VERTEX_HIT_HALO`` so edge hits and vertex hits feel consistent.
 * Plan-09 Phase 5 Task 12.
 */
export const INSERT_TOLERANCE_PX = 6;

/**
 * Project ``p`` onto the segment ``a``→``b`` (clamped to the segment, not
 * the infinite line). Returns the projected point and its squared distance
 * to ``p``. Internal helper for ``hitTestEdge``.
 */
function projectOntoSegment(
  p: { x: number; y: number },
  a: [number, number],
  b: [number, number],
): { projected: { x: number; y: number }; distSq: number } {
  const ax = a[0];
  const ay = a[1];
  const bx = b[0];
  const by = b[1];
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq > 0 ? ((p.x - ax) * dx + (p.y - ay) * dy) / lenSq : 0;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  const px = ax + t * dx;
  const py = ay + t * dy;
  const ex = p.x - px;
  const ey = p.y - py;
  return { projected: { x: px, y: py }, distSq: ex * ex + ey * ey };
}

/**
 * Hit-test against a polygon's edges. Returns the index of the edge whose
 * closest point to ``cursor`` is within ``tolerance`` pixels (defaults to
 * ``INSERT_TOLERANCE_PX``), along with the projected point on that edge.
 * Edges are indexed by their starting vertex: edge ``i`` runs from
 * ``points[i]`` to ``points[(i + 1) % n]``. Returns ``null`` when no edge
 * is within tolerance.
 *
 * When two edges are within tolerance the closest one wins (squared
 * distance), which matches user intent when alt-clicking near a vertex
 * shared by two edges.
 */
export function hitTestEdge(
  poly: Polygon,
  cursor: { x: number; y: number },
  tolerance: number = INSERT_TOLERANCE_PX,
): { edgeIndex: number; projected: { x: number; y: number } } | null {
  const pts = poly.points;
  if (pts.length < 2) return null;
  const tolSq = tolerance * tolerance;
  let best: {
    edgeIndex: number;
    projected: { x: number; y: number };
    distSq: number;
  } | null = null;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const r = projectOntoSegment(cursor, a, b);
    if (r.distSq <= tolSq && (best === null || r.distSq < best.distSq)) {
      best = { edgeIndex: i, projected: r.projected, distSq: r.distSq };
    }
  }
  if (!best) return null;
  return { edgeIndex: best.edgeIndex, projected: best.projected };
}

/**
 * Returns a new polygon with ``point`` inserted between the two endpoints
 * of edge ``edgeIndex``. The new vertex's index is ``edgeIndex + 1`` so
 * subsequent vertex-drag callers can target it directly. Returns the
 * original polygon unchanged if ``edgeIndex`` is out of range.
 */
export function insertVertex(
  poly: Polygon,
  edgeIndex: number,
  point: { x: number; y: number },
): Polygon {
  if (edgeIndex < 0 || edgeIndex >= poly.points.length) return poly;
  const next: [number, number][] = [
    ...poly.points.slice(0, edgeIndex + 1),
    [point.x, point.y],
    ...poly.points.slice(edgeIndex + 1),
  ];
  return { kind: "polygon", points: next };
}

/**
 * Plan-09b Task 2 — pure predicate for the alt+hover edge-insert ghost
 * dot. The ghost is shown only when ALL preconditions hold: the cursor
 * tool is active, alt is held, a polygon is selected, and the cursor
 * is within INSERT_TOLERANCE_PX of an edge.
 *
 * Extracted as a pure function so the AnnotationCanvas integration can
 * be exercised in isolation without instantiating Pixi mocks.
 */
export function shouldShowEdgeGhost(args: {
  tool: string;
  alt: boolean;
  polygonSelected: boolean;
  hit: { edgeIndex: number; projected: { x: number; y: number } } | null;
}): boolean {
  return (
    args.tool === "cursor" &&
    args.alt === true &&
    args.polygonSelected === true &&
    args.hit !== null
  );
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
