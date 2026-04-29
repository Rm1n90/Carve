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
 * Translate the current frame by ``(dx, dy)`` host pixels without changing
 * the scale. Used by the canvas pan affordances (Space-hold + drag, and
 * middle-mouse drag) introduced in v3.2 to fix Issue 2 — once the user
 * zoomed in past the host bounds, there was no way to reach the
 * off-screen portion of the image. Pure helper, mirrors ``zoomAt`` /
 * ``zoomCentered`` in keeping the math out of the React component for
 * cheap unit tests.
 */
export function panBy(frame: ZoomFrame, dx: number, dy: number): ZoomFrame {
  return {
    scale: frame.scale,
    offset: { x: frame.offset.x + dx, y: frame.offset.y + dy },
  };
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
 * Per-event clamp range for the wheel zoom factor. Without this a
 * runaway 1000+ pixel trackpad pinch would multiply scale wildly in a
 * single frame; clamping keeps the user's perceived zoom rate sane
 * regardless of deltaY magnitude. Values chosen so `2.0` is roughly
 * the maximum zoom-in per event (and `0.5` the maximum zoom-out),
 * which is a comfortable upper bound — past that the user sees a
 * "pop" rather than a smooth motion. v2.7 wave 2 item 6.
 */
export const WHEEL_FACTOR_MAX = 2.0;
export const WHEEL_FACTOR_MIN = 0.5;

/**
 * Convert a wheel-event ``deltaY`` value into a zoom factor. Negative
 * deltaY (wheel-up / scroll-up) zooms in; positive zooms out.
 *
 * v2.7 wave 2 item 6 — proportional smooth zoom. The factor follows
 * an exp curve so |deltaY| scales the result continuously: a small
 * trackpad pinch barely moves; a fast swipe still zooms quickly. The
 * decay constant `k = ln(step) / 100` calibrates the curve so a
 * 100-pixel notch (the typical browser wheel step) keeps the previous
 * `step` factor — that preserves backward compatibility with the
 * "feels like one notch" muscle memory while the rest of the curve
 * flows smoothly.
 *
 * The factor is clamped to [WHEEL_FACTOR_MIN, WHEEL_FACTOR_MAX] so a
 * runaway pinch can't wildly multiply scale in a single frame.
 */
export function wheelDeltaToFactor(deltaY: number, step = ZOOM_STEP): number {
  if (!Number.isFinite(deltaY) || deltaY === 0) return 1;
  // Calibration: factor(-100) === step exactly (round-trips the old
  // single-notch behaviour). factor(d) * factor(-d) === 1.
  const k = Math.log(step) / 100;
  const raw = Math.exp(-deltaY * k);
  if (raw > WHEEL_FACTOR_MAX) return WHEEL_FACTOR_MAX;
  if (raw < WHEEL_FACTOR_MIN) return WHEEL_FACTOR_MIN;
  return raw;
}

function sanitizeSize(s: Size): Size {
  return {
    w: Number.isFinite(s.w) ? s.w : 0,
    h: Number.isFinite(s.h) ? s.h : 0,
  };
}
