/**
 * Pure zoom-math helpers used by the AnnotationCanvas.
 *
 * The canvas keeps two pieces of state for projecting an image onto its
 * host element:
 *   - `scale` — uniform factor applied to the image (and to the shape /
 *     overlay layers, since they share the same Pixi transform).
 *   - `offset` — translation in host pixels of the image's top-left
 *     corner inside the host element.
 *
 * Every zoom interaction (wheel, +/- buttons, fit, 1:1, exact %) goes
 * through one of the helpers here so the math stays in one place and
 * is easy to unit-test without spinning up jsdom or Pixi.
 *
 * Coordinate spaces:
 *   - "host" — pixels inside the canvas host `<div>` (0,0 = top-left of
 *     the host).
 *   - "image" — pixels inside the source image (0,0 = top-left of the
 *     image bitmap).
 *
 * The mapping is:
 *   imageX = (hostX - offsetX) / scale
 *   hostX  = imageX * scale + offsetX
 */

/** Allowed scale range. Values outside the range get clamped. */
export const MIN_SCALE = 0.1;
export const MAX_SCALE = 10;

/** Default per-step zoom factor for wheel + button zoom. */
export const ZOOM_STEP = 1.1;

export interface Size {
  readonly w: number;
  readonly h: number;
}

export interface Offset {
  readonly x: number;
  readonly y: number;
}

export interface ZoomFrame {
  readonly scale: number;
  readonly offset: Offset;
}

/**
 * Clamp a scale value to the allowed range. NaN / Infinity collapse to
 * the minimum so the renderer never receives a degenerate transform.
 */
export function clampScale(scale: number): number {
  if (!Number.isFinite(scale)) return MIN_SCALE;
  if (scale < MIN_SCALE) return MIN_SCALE;
  if (scale > MAX_SCALE) return MAX_SCALE;
  return scale;
}

/**
 * Compute the fit-to-host scale and centered offset for a given host /
 * image size pair. Reproduces the original AnnotationCanvas behaviour:
 * shrink to fit when the image is larger than the host (with a 16px
 * padding), but never upscale past 1:1.
 */
export function fitToHost(
  host: Size,
  image: Size,
  padding = 16,
): ZoomFrame {
  const safeHost = sanitizeSize(host);
  const safeImage = sanitizeSize(image);
  if (safeHost.w <= 0 || safeHost.h <= 0 || safeImage.w <= 0 || safeImage.h <= 0) {
    return { scale: 1, offset: { x: 0, y: 0 } };
  }
  const sx = (safeHost.w - padding * 2) / safeImage.w;
  const sy = (safeHost.h - padding * 2) / safeImage.h;
  const scale = clampScale(Math.min(sx, sy, 1));
  const drawnW = safeImage.w * scale;
  const drawnH = safeImage.h * scale;
  const offset = {
    x: (safeHost.w - drawnW) / 2,
    y: (safeHost.h - drawnH) / 2,
  };
  return { scale, offset };
}

/**
 * Compute a centered offset for an arbitrary scale value. Used by the
 * +/- buttons (which don't have a cursor anchor) and by the 1:1 button.
 */
export function centeredOffset(host: Size, image: Size, scale: number): Offset {
  const safeHost = sanitizeSize(host);
  const safeImage = sanitizeSize(image);
  const drawnW = safeImage.w * scale;
  const drawnH = safeImage.h * scale;
  return {
    x: (safeHost.w - drawnW) / 2,
    y: (safeHost.h - drawnH) / 2,
  };
}

/**
 * Apply a multiplicative zoom step anchored at a host-space point. The
 * image-space pixel currently under the anchor stays under the anchor
 * after the zoom (CVAT-style cursor-anchored wheel zoom).
 *
 * Implementation note: we recover the image-space point from the *old*
 * frame, then rebuild the offset so the same image-space point maps to
 * the same host-space point after the new scale is applied.
 */
export function zoomAt(
  current: ZoomFrame,
  factor: number,
  anchor: { x: number; y: number },
): ZoomFrame {
  const nextScale = clampScale(current.scale * factor);
  // Recover image-space point under the anchor before the zoom.
  const safeScale = current.scale === 0 ? 1 : current.scale;
  const imgX = (anchor.x - current.offset.x) / safeScale;
  const imgY = (anchor.y - current.offset.y) / safeScale;
  // Solve for the offset that pins the image-space point to the same
  // host-space anchor at the new scale.
  const offset = {
    x: anchor.x - imgX * nextScale,
    y: anchor.y - imgY * nextScale,
  };
  return { scale: nextScale, offset };
}

/**
 * Zoom by a step factor anchored to the centre of the host. Used by the
 * `+` / `-` toolbar buttons and the keyboard shortcuts.
 */
export function zoomCentered(
  current: ZoomFrame,
  host: Size,
  factor: number,
): ZoomFrame {
  const safeHost = sanitizeSize(host);
  return zoomAt(current, factor, {
    x: safeHost.w / 2,
    y: safeHost.h / 2,
  });
}

/**
 * Convert a wheel-event ``deltaY`` value into a zoom factor. Negative
 * deltaY (wheel-up / scroll-up) zooms in; positive zooms out. The
 * step magnitude is constant — most browsers send |deltaY| ≈ 100 for a
 * single notch, so we just key off the sign.
 */
export function wheelDeltaToFactor(deltaY: number, step = ZOOM_STEP): number {
  if (deltaY === 0) return 1;
  return deltaY < 0 ? step : 1 / step;
}

function sanitizeSize(s: Size): Size {
  return {
    w: Number.isFinite(s.w) ? s.w : 0,
    h: Number.isFinite(s.h) ? s.h : 0,
  };
}
