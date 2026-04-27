/**
 * Pure math for bbox move/resize. Lives separately from AnnotationCanvas
 * so the geometry can be unit-tested without instantiating Pixi.
 *
 * Design notes (audit bug 2 / B):
 * - Translate moves x/y; w/h are preserved.
 * - Resize manipulates corners and edges. Each handle anchors the OPPOSITE
 *   side of the bbox: e.g. SE keeps the NW corner fixed.
 * - Min-size clamp prevents a 0×0 rectangle. We hold the anchor in place
 *   and floor the moving side so the bbox stays at >= MIN_BBOX_SIZE.
 */
import type { Bbox } from "@/state/annotations";
import {
  BBOX_HANDLE_SIZE_PX,
  type BboxHandleName,
  getBboxHandlePositions,
} from "./ShapeRenderer";

export const MIN_BBOX_SIZE = 4;

/** Half the visual handle box, used for square hit-test bounds. */
const HANDLE_HALF = BBOX_HANDLE_SIZE_PX / 2;
/** Hit-test halo: clicks within this many image-pixels of a handle's
 * centre still count as hitting it. Slightly larger than the visual size
 * to make small handles easier to grab. */
const HANDLE_HIT_HALO = HANDLE_HALF + 2;

/** Apply a translation: bbox's top-left moves to ``(newX, newY)``;
 * width and height are preserved. The caller is responsible for any
 * image-bounds clamping; this utility is intentionally bound-agnostic. */
export function applyTranslate(b: Bbox, newX: number, newY: number): Bbox {
  return { kind: "bbox", x: newX, y: newY, w: b.w, h: b.h };
}

/** Apply a resize for the given handle. The fixed anchor depends on the
 * handle: e.g. handle "se" keeps the NW corner fixed. ``cursor`` is the
 * pointer position in image coordinates. */
export function applyResize(
  original: Bbox,
  handle: BboxHandleName,
  cursor: { x: number; y: number },
): Bbox {
  const ox = original.x;
  const oy = original.y;
  const oRight = original.x + original.w;
  const oBottom = original.y + original.h;

  let x = ox;
  let y = oy;
  let w = original.w;
  let h = original.h;

  switch (handle) {
    case "nw":
      x = Math.min(cursor.x, oRight - MIN_BBOX_SIZE);
      y = Math.min(cursor.y, oBottom - MIN_BBOX_SIZE);
      w = oRight - x;
      h = oBottom - y;
      break;
    case "ne":
      y = Math.min(cursor.y, oBottom - MIN_BBOX_SIZE);
      w = Math.max(MIN_BBOX_SIZE, cursor.x - ox);
      h = oBottom - y;
      x = ox;
      break;
    case "se":
      w = Math.max(MIN_BBOX_SIZE, cursor.x - ox);
      h = Math.max(MIN_BBOX_SIZE, cursor.y - oy);
      x = ox;
      y = oy;
      break;
    case "sw":
      x = Math.min(cursor.x, oRight - MIN_BBOX_SIZE);
      w = oRight - x;
      h = Math.max(MIN_BBOX_SIZE, cursor.y - oy);
      y = oy;
      break;
    case "n":
      y = Math.min(cursor.y, oBottom - MIN_BBOX_SIZE);
      h = oBottom - y;
      x = ox;
      w = original.w;
      break;
    case "s":
      h = Math.max(MIN_BBOX_SIZE, cursor.y - oy);
      x = ox;
      y = oy;
      w = original.w;
      break;
    case "e":
      w = Math.max(MIN_BBOX_SIZE, cursor.x - ox);
      x = ox;
      y = oy;
      h = original.h;
      break;
    case "w":
      x = Math.min(cursor.x, oRight - MIN_BBOX_SIZE);
      w = oRight - x;
      y = oy;
      h = original.h;
      break;
  }

  return { kind: "bbox", x, y, w, h };
}

/** Hit-test against a bbox's 8 handles. Returns the first handle name
 * whose centre is within ``HANDLE_HIT_HALO`` of the cursor, or null.
 * Corner handles are tested first (matches BBOX_HANDLE_NAMES order),
 * which matters at zero-width / zero-height bboxes where corner and
 * edge handles overlap. */
export function hitTestHandle(
  b: Bbox,
  cursor: { x: number; y: number },
): BboxHandleName | null {
  for (const spec of getBboxHandlePositions(b)) {
    if (
      Math.abs(cursor.x - spec.cx) <= HANDLE_HIT_HALO &&
      Math.abs(cursor.y - spec.cy) <= HANDLE_HIT_HALO
    ) {
      return spec.name;
    }
  }
  return null;
}

/** Returns true if the cursor is strictly inside the bbox interior
 * (used for translate-on-drag detection — handles take priority). */
export function pointInsideBbox(
  b: Bbox,
  cursor: { x: number; y: number },
): boolean {
  return (
    cursor.x >= b.x &&
    cursor.x <= b.x + b.w &&
    cursor.y >= b.y &&
    cursor.y <= b.y + b.h
  );
}
