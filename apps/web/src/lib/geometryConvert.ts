// Armin Mehri — mehri.armin@gmail.com
//
// Plan-17 — geometry conversion utilities.
//
// Three direction-pure operations:
//   - polygonPointsToBbox: array of (x,y) -> axis-aligned Bbox
//   - maskRleToBbox: RLE-encoded mask -> axis-aligned Bbox
//   - bboxOfGeometry: any Geometry -> Bbox (returns null for tags)
//
// SAM-based conversions live in samConvert.ts because they need an
// async server roundtrip; this module stays purely synchronous so it
// can be used inside reducers and selectors without refactoring.
import { decodeRLE } from "@/canvas/maskio";
import type { Bbox, Geometry, Polygon } from "@/state/annotations";

/**
 * Compute the axis-aligned bounding box of a polygon's vertex list.
 * Returns a Bbox geometry positioned at (minX, minY). Empty point lists
 * collapse to a 0-sized box at the origin (callers should guard).
 */
export function polygonPointsToBbox(
  points: ReadonlyArray<readonly [number, number]>,
): Bbox {
  if (points.length === 0) {
    return { kind: "bbox", x: 0, y: 0, w: 0, h: 0 };
  }
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const [x, y] of points) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return {
    kind: "bbox",
    x: minX,
    y: minY,
    w: Math.max(0, maxX - minX),
    h: Math.max(0, maxY - minY),
  };
}

/**
 * Compute the axis-aligned bounding box of an RLE-encoded mask. Decodes
 * the RLE and scans for the bounds of non-zero pixels. Returns a 0-sized
 * box at the origin when the mask is empty.
 *
 * The size is `[h, w]` per the project's existing Mask geometry shape.
 * The mask buffer is column-major per the encodeRLE/decodeRLE convention.
 */
export function maskRleToBbox(counts: string, size: [number, number]): Bbox {
  const [h, w] = size;
  const mask = decodeRLE(counts, h, w);
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      if (mask[x * h + y]) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) {
    return { kind: "bbox", x: 0, y: 0, w: 0, h: 0 };
  }
  return {
    kind: "bbox",
    x: minX,
    y: minY,
    w: maxX - minX + 1,
    h: maxY - minY + 1,
  };
}

/**
 * Convenience: bbox-ify any annotation geometry. Returns null for tag
 * geometries (no spatial extent).
 */
export function bboxOfGeometry(g: Geometry): Bbox | null {
  if (g.kind === "bbox") return g;
  if (g.kind === "polygon") return polygonPointsToBbox(g.points);
  if (g.kind === "mask_rle") return maskRleToBbox(g.counts, g.size);
  return null;
}

/**
 * Build a Polygon geometry from a vertex list. Validates that the list
 * has ≥3 distinct points so the polygon has area; returns `null` when
 * the input would degenerate. The caller decides what to do (typically
 * fall back to keeping the original geometry).
 */
export function buildPolygon(
  points: ReadonlyArray<readonly [number, number]>,
): Polygon | null {
  if (points.length < 3) return null;
  return {
    kind: "polygon",
    points: points.map(([x, y]) => [x, y] as [number, number]),
  };
}
