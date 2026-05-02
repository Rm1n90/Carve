// Armin Mehri — mehri.armin@gmail.com
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

/**
 * Image bounds used for translate / resize clamping. Optional — when null,
 * the helpers fall back to the legacy bound-agnostic behaviour (used by
 * tests that don't care about clamping and by the canvas before the image
 * texture has loaded). v2.5.2.
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

/** Half the visual handle box, used for square hit-test bounds. */
const HANDLE_HALF = BBOX_HANDLE_SIZE_PX / 2;
/** Hit-test halo: clicks within this many image-pixels of a handle's
 * centre still count as hitting it. Slightly larger than the visual size
 * to make small handles easier to grab. */
const HANDLE_HIT_HALO = HANDLE_HALF + 2;

/**
 * Apply a translation: bbox's top-left moves to ``(newX, newY)``; width
 * and height are preserved. When `bounds` is provided the resulting
 * top-left is clamped so the bbox stays fully inside the image:
 *  - `x` ∈ [0, max(0, bounds.w - b.w)]
 *  - `y` ∈ [0, max(0, bounds.h - b.h)]
 *
 * Bbox bigger than the image (rare — e.g. resize-then-shrink-image)
 * collapses the upper bound to 0 rather than going negative; the bbox
 * sticks to the top-left corner. v2.5.2.
 */
export function applyTranslate(
  b: Bbox,
  newX: number,
  newY: number,
  bounds: ImageBounds | null = null,
): Bbox {
  if (!bounds) {
    return { kind: "bbox", x: newX, y: newY, w: b.w, h: b.h };
  }
  const maxX = Math.max(0, bounds.w - b.w);
  const maxY = Math.max(0, bounds.h - b.h);
  return {
    kind: "bbox",
    x: clamp(newX, 0, maxX),
    y: clamp(newY, 0, maxY),
    w: b.w,
    h: b.h,
  };
}

/**
 * Apply a resize for the given handle. The fixed anchor depends on the
 * handle: e.g. handle "se" keeps the NW corner fixed. ``cursor`` is the
 * pointer position in image coordinates.
 *
 * When `bounds` is provided the cursor is first clamped to the image
 * rectangle so the moving side cannot escape — combined with the
 * existing MIN_BBOX_SIZE clamp this gives a bbox that always satisfies
 * `0 <= x, x+w <= bounds.w, 0 <= y, y+h <= bounds.h`. v2.5.2.
 */
export function applyResize(
  original: Bbox,
  handle: BboxHandleName,
  cursor: { x: number; y: number },
  bounds: ImageBounds | null = null,
): Bbox {
  const ox = original.x;
  const oy = original.y;
  const oRight = original.x + original.w;
  const oBottom = original.y + original.h;

  // Pre-clamp the cursor to the image rectangle. Subsequent MIN_BBOX_SIZE
  // logic still applies — these are independent invariants and either can
  // be the binding constraint depending on cursor position.
  const cx = bounds ? clamp(cursor.x, 0, bounds.w) : cursor.x;
  const cy = bounds ? clamp(cursor.y, 0, bounds.h) : cursor.y;

  let x = ox;
  let y = oy;
  let w = original.w;
  let h = original.h;

  switch (handle) {
    case "nw":
      x = Math.min(cx, oRight - MIN_BBOX_SIZE);
      y = Math.min(cy, oBottom - MIN_BBOX_SIZE);
      w = oRight - x;
      h = oBottom - y;
      break;
    case "ne":
      y = Math.min(cy, oBottom - MIN_BBOX_SIZE);
      w = Math.max(MIN_BBOX_SIZE, cx - ox);
      h = oBottom - y;
      x = ox;
      break;
    case "se":
      w = Math.max(MIN_BBOX_SIZE, cx - ox);
      h = Math.max(MIN_BBOX_SIZE, cy - oy);
      x = ox;
      y = oy;
      break;
    case "sw":
      x = Math.min(cx, oRight - MIN_BBOX_SIZE);
      w = oRight - x;
      h = Math.max(MIN_BBOX_SIZE, cy - oy);
      y = oy;
      break;
    case "n":
      y = Math.min(cy, oBottom - MIN_BBOX_SIZE);
      h = oBottom - y;
      x = ox;
      w = original.w;
      break;
    case "s":
      h = Math.max(MIN_BBOX_SIZE, cy - oy);
      x = ox;
      y = oy;
      w = original.w;
      break;
    case "e":
      w = Math.max(MIN_BBOX_SIZE, cx - ox);
      x = ox;
      y = oy;
      h = original.h;
      break;
    case "w":
      x = Math.min(cx, oRight - MIN_BBOX_SIZE);
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
