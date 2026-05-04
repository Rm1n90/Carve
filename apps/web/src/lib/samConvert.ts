// Armin Mehri — mehri.armin@gmail.com
//
// Plan-17 — SAM-backed geometry conversions.
//
// Server roundtrip helpers used by the right-click "Convert ▸" submenu
// and the YOLO/Auto-annotate post-processing checkboxes.
//
// Both supported directions (BBox→Polygon, Polygon→refined Polygon)
// reduce to "given an axis-aligned box on this asset, give me back a
// SAM polygon", which `samApi.boxPrompt` already provides.
import { samApi } from "@/api/sam";
import { bboxOfGeometry } from "@/lib/geometryConvert";
import type { Bbox, Geometry } from "@/state/annotations";

export interface SamRefineParams {
  assetId: string;
  frameId?: string | null;
  /** xyxy in image-space pixels. */
  box: [number, number, number, number];
}

/**
 * Run a single SAM box-prompt and return the produced polygon vertices.
 * Returns ``null`` when SAM did not produce a usable polygon (no
 * candidate or the active variant cannot polygonize) — the caller
 * keeps the original geometry instead of replacing it with garbage.
 */
export async function samBoxToPolygonPoints({
  assetId,
  frameId,
  box,
}: SamRefineParams): Promise<[number, number][] | null> {
  const results = await samApi.boxPrompt(
    assetId,
    [box],
    [1],
    undefined,
    frameId ?? null,
  );
  if (!results || results.length === 0) return null;
  const best = results.reduce((a, b) => (b.score > a.score ? b : a));
  if (!best.polygon || best.polygon.length < 3) return null;
  return best.polygon.map(([x, y]) => [x, y] as [number, number]);
}

/**
 * Given any geometry on a known asset, compute its bounding box and
 * ask SAM for a polygon for that region. Returns the new vertex list
 * or null on failure.
 */
export async function samPolygonForGeometry({
  assetId,
  frameId,
  geometry,
}: {
  assetId: string;
  frameId?: string | null;
  geometry: Geometry;
}): Promise<[number, number][] | null> {
  const box = bboxOfGeometry(geometry);
  if (!box) return null;
  if (box.w < 1 || box.h < 1) return null;
  const xyxy: [number, number, number, number] = [
    box.x,
    box.y,
    box.x + box.w,
    box.y + box.h,
  ];
  return samBoxToPolygonPoints({ assetId, frameId, box: xyxy });
}

/**
 * Inflate a Bbox a few pixels in every direction (clamped to optional
 * image bounds). Useful before refining a tight YOLO mask polygon —
 * SAM gets a little boundary context instead of being clipped to the
 * predicted edge.
 */
export function inflateBbox(
  b: Bbox,
  padPx: number,
  bounds?: { w: number; h: number },
): Bbox {
  let x = b.x - padPx;
  let y = b.y - padPx;
  let w = b.w + 2 * padPx;
  let h = b.h + 2 * padPx;
  if (bounds) {
    if (x < 0) {
      w += x;
      x = 0;
    }
    if (y < 0) {
      h += y;
      y = 0;
    }
    if (x + w > bounds.w) w = Math.max(0, bounds.w - x);
    if (y + h > bounds.h) h = Math.max(0, bounds.h - y);
  }
  return { kind: "bbox", x, y, w, h };
}
