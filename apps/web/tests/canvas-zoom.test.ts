import { describe, expect, it } from "vitest";
import {
  centeredOffset,
  clampScale,
  fitToHost,
  MAX_SCALE,
  MIN_SCALE,
  wheelDeltaToFactor,
  zoomAt,
  zoomCentered,
  ZOOM_STEP,
  type ZoomFrame,
} from "@/canvas/zoom";

/**
 * Pure-math tests for the zoom helpers introduced in v2.6 (CVAT-style
 * cursor-anchored wheel zoom + toolbar buttons + 1:1).
 *
 * The helpers are intentionally separated from the AnnotationCanvas
 * react component so we can test the actual algorithm — including the
 * cursor-anchored offset reconstruction — without spinning up Pixi or
 * jsdom.
 */
describe("canvas zoom helpers", () => {
  // Helper used by the cursor-anchored tests. Maps an image-space
  // point through a (scale, offset) transform to host space; we use
  // it to assert that the same image-space point maps to the same
  // host-space point before and after a zoom step.
  function projectToHost(frame: ZoomFrame, image: { x: number; y: number }) {
    return {
      x: image.x * frame.scale + frame.offset.x,
      y: image.y * frame.scale + frame.offset.y,
    };
  }

  describe("clampScale", () => {
    it("returns the input when it is already inside the allowed range", () => {
      expect(clampScale(1)).toBe(1);
      expect(clampScale(0.5)).toBe(0.5);
      expect(clampScale(5)).toBe(5);
    });

    it("clamps below MIN_SCALE", () => {
      expect(clampScale(0)).toBe(MIN_SCALE);
      expect(clampScale(-1)).toBe(MIN_SCALE);
      expect(clampScale(MIN_SCALE - 0.01)).toBe(MIN_SCALE);
    });

    it("clamps above MAX_SCALE", () => {
      expect(clampScale(MAX_SCALE + 1)).toBe(MAX_SCALE);
      expect(clampScale(1000)).toBe(MAX_SCALE);
    });

    it("collapses NaN and Infinity to MIN_SCALE", () => {
      expect(clampScale(Number.NaN)).toBe(MIN_SCALE);
      expect(clampScale(Number.POSITIVE_INFINITY)).toBe(MIN_SCALE);
    });
  });

  describe("wheelDeltaToFactor", () => {
    it("zooms in when deltaY is negative (wheel up)", () => {
      // Wheel-up — image gets bigger.
      expect(wheelDeltaToFactor(-100)).toBeGreaterThan(1);
    });

    it("zooms out when deltaY is positive (wheel down)", () => {
      // Wheel-down — image gets smaller.
      expect(wheelDeltaToFactor(100)).toBeLessThan(1);
    });

    it("returns 1 when deltaY is zero (no movement)", () => {
      expect(wheelDeltaToFactor(0)).toBe(1);
    });

    // v2.7 wave 2 item 6 — proportional smooth wheel zoom.
    // The original implementation returned a constant ZOOM_STEP / (1/ZOOM_STEP)
    // regardless of |deltaY|, which made trackpad pinch + fast scroll feel
    // jerky and discrete. The replacement uses an exp curve so |deltaY|
    // proportionally scales the factor while preserving the previous
    // calibration at |deltaY|=100 (the typical browser wheel notch).

    it("calibration: |deltaY| = 100 still yields ~ZOOM_STEP (smooth replacement is backward-compatible)", () => {
      expect(wheelDeltaToFactor(-100)).toBeCloseTo(ZOOM_STEP, 1);
      expect(wheelDeltaToFactor(100)).toBeCloseTo(1 / ZOOM_STEP, 2);
    });

    it("proportionality: factor(-50) and factor(-200) differ (was a constant before fix)", () => {
      const small = wheelDeltaToFactor(-50);
      const big = wheelDeltaToFactor(-200);
      expect(small).not.toBe(big);
      // Larger magnitude must produce a larger zoom-in factor.
      expect(big).toBeGreaterThan(small);
    });

    it("monotonic: factor(-50) < factor(-100) < factor(-200) (zoom-in side)", () => {
      expect(wheelDeltaToFactor(-50)).toBeLessThan(
        wheelDeltaToFactor(-100),
      );
      expect(wheelDeltaToFactor(-100)).toBeLessThan(
        wheelDeltaToFactor(-200),
      );
    });

    it("monotonic: factor(50) > factor(100) > factor(200) (zoom-out side)", () => {
      expect(wheelDeltaToFactor(50)).toBeGreaterThan(
        wheelDeltaToFactor(100),
      );
      expect(wheelDeltaToFactor(100)).toBeGreaterThan(
        wheelDeltaToFactor(200),
      );
    });

    it("symmetry: factor(d) * factor(-d) ~= 1 for any d", () => {
      for (const d of [10, 50, 100, 250, 500]) {
        const product = wheelDeltaToFactor(d) * wheelDeltaToFactor(-d);
        expect(product).toBeCloseTo(1, 5);
      }
    });

    it("clamps a runaway pinch so per-event factor stays sane", () => {
      // A 1000-pixel pinch must not 8x scale in one frame; the
      // per-event factor is clamped to the [0.5, 2.0] range.
      expect(wheelDeltaToFactor(-5000)).toBeLessThanOrEqual(2.0);
      expect(wheelDeltaToFactor(5000)).toBeGreaterThanOrEqual(0.5);
      // The clamp must STILL produce a meaningful zoom — never collapse to 1.
      expect(wheelDeltaToFactor(-5000)).toBeGreaterThan(1);
      expect(wheelDeltaToFactor(5000)).toBeLessThan(1);
    });
  });

  describe("fitToHost", () => {
    it("returns identity when the image is smaller than the host", () => {
      const fit = fitToHost({ w: 1000, h: 1000 }, { w: 200, h: 100 });
      expect(fit.scale).toBe(1);
      // Centred horizontally and vertically inside the host.
      expect(fit.offset.x).toBeCloseTo((1000 - 200) / 2, 5);
      expect(fit.offset.y).toBeCloseTo((1000 - 100) / 2, 5);
    });

    it("shrinks to fit when the image is larger than the host", () => {
      const fit = fitToHost({ w: 320, h: 240 }, { w: 1600, h: 800 }, 0);
      // Limiting axis is width: 320/1600 = 0.2.
      expect(fit.scale).toBeCloseTo(0.2, 5);
      // Centred vertically — drawn height is 800 * 0.2 = 160, so the
      // top offset is (240-160)/2 = 40.
      expect(fit.offset.y).toBeCloseTo(40, 5);
    });

    it("returns a sane default when host or image dimensions are zero", () => {
      const fit = fitToHost({ w: 0, h: 0 }, { w: 100, h: 100 });
      expect(fit.scale).toBe(1);
      expect(fit.offset).toEqual({ x: 0, y: 0 });
    });
  });

  describe("centeredOffset", () => {
    it("centres the image inside the host at the requested scale", () => {
      const off = centeredOffset({ w: 1000, h: 800 }, { w: 200, h: 200 }, 2);
      // drawn is 400x400 → off should be (1000-400)/2 = 300, (800-400)/2 = 200
      expect(off).toEqual({ x: 300, y: 200 });
    });
  });

  describe("zoomAt — cursor-anchored zoom (CVAT-style)", () => {
    it("multiplies the scale by the requested factor", () => {
      const start: ZoomFrame = { scale: 1, offset: { x: 0, y: 0 } };
      const after = zoomAt(start, ZOOM_STEP, { x: 0, y: 0 });
      expect(after.scale).toBeCloseTo(ZOOM_STEP, 10);
    });

    it("clamps scale within [MIN_SCALE, MAX_SCALE] across many steps", () => {
      // Start at 1.0, zoom in 50 times — should saturate at MAX_SCALE.
      let frame: ZoomFrame = { scale: 1, offset: { x: 0, y: 0 } };
      for (let i = 0; i < 50; i += 1) {
        frame = zoomAt(frame, ZOOM_STEP, { x: 100, y: 100 });
      }
      expect(frame.scale).toBe(MAX_SCALE);

      // Now zoom out 50 times — should saturate at MIN_SCALE.
      for (let i = 0; i < 50; i += 1) {
        frame = zoomAt(frame, 1 / ZOOM_STEP, { x: 100, y: 100 });
      }
      expect(frame.scale).toBe(MIN_SCALE);
    });

    it("keeps the image-space point under the cursor pinned to the cursor", () => {
      // Start: scale 1, image-top-left at host (50, 30). So host (250,
      // 130) maps to image (200, 100).
      const start: ZoomFrame = { scale: 1, offset: { x: 50, y: 30 } };
      const cursor = { x: 250, y: 130 };

      // Pre-zoom: which image-space pixel is under the cursor?
      const imgUnderCursorBefore = {
        x: (cursor.x - start.offset.x) / start.scale,
        y: (cursor.y - start.offset.y) / start.scale,
      };
      expect(imgUnderCursorBefore).toEqual({ x: 200, y: 100 });

      const after = zoomAt(start, ZOOM_STEP, cursor);

      // After the zoom, the image-space point that was under the cursor
      // must project back to the same host-space cursor location.
      const projected = projectToHost(after, imgUnderCursorBefore);
      expect(projected.x).toBeCloseTo(cursor.x, 10);
      expect(projected.y).toBeCloseTo(cursor.y, 10);
    });

    it("keeps the cursor anchor stable across multiple zoom-in steps", () => {
      const cursor = { x: 400, y: 300 };
      let frame: ZoomFrame = { scale: 1, offset: { x: 100, y: 75 } };
      const imgUnderCursor = {
        x: (cursor.x - frame.offset.x) / frame.scale,
        y: (cursor.y - frame.offset.y) / frame.scale,
      };
      // Zoom in three times in a row.
      for (let i = 0; i < 3; i += 1) {
        frame = zoomAt(frame, ZOOM_STEP, cursor);
      }
      const projected = projectToHost(frame, imgUnderCursor);
      expect(projected.x).toBeCloseTo(cursor.x, 8);
      expect(projected.y).toBeCloseTo(cursor.y, 8);
    });

    it("keeps the cursor anchor stable across mixed zoom-in / zoom-out", () => {
      const cursor = { x: 250, y: 150 };
      let frame: ZoomFrame = { scale: 1.5, offset: { x: 20, y: 10 } };
      const imgUnderCursor = {
        x: (cursor.x - frame.offset.x) / frame.scale,
        y: (cursor.y - frame.offset.y) / frame.scale,
      };
      frame = zoomAt(frame, ZOOM_STEP, cursor);
      frame = zoomAt(frame, ZOOM_STEP, cursor);
      frame = zoomAt(frame, 1 / ZOOM_STEP, cursor);
      const projected = projectToHost(frame, imgUnderCursor);
      expect(projected.x).toBeCloseTo(cursor.x, 8);
      expect(projected.y).toBeCloseTo(cursor.y, 8);
    });
  });

  describe("zoomCentered — used by + / − toolbar buttons", () => {
    it("zooms in by ZOOM_STEP about the host centre", () => {
      const start: ZoomFrame = { scale: 1, offset: { x: 0, y: 0 } };
      const next = zoomCentered(start, { w: 800, h: 600 }, ZOOM_STEP);
      expect(next.scale).toBeCloseTo(ZOOM_STEP, 10);
      // Centre of the host (400, 300) must remain on the same image
      // pixel after zoom.
      const imgUnderCenter = {
        x: (400 - start.offset.x) / start.scale,
        y: (300 - start.offset.y) / start.scale,
      };
      const proj = {
        x: imgUnderCenter.x * next.scale + next.offset.x,
        y: imgUnderCenter.y * next.scale + next.offset.y,
      };
      expect(proj.x).toBeCloseTo(400, 8);
      expect(proj.y).toBeCloseTo(300, 8);
    });

    it("zooms out by 1/ZOOM_STEP when the factor is the inverse step", () => {
      const start: ZoomFrame = { scale: 2, offset: { x: 0, y: 0 } };
      const next = zoomCentered(start, { w: 800, h: 600 }, 1 / ZOOM_STEP);
      expect(next.scale).toBeCloseTo(2 / ZOOM_STEP, 10);
    });
  });

  describe("composition: 1:1 produces scale 1.0 with centered offset", () => {
    it("setting scale 1 with centeredOffset places the image in the middle of the host", () => {
      const host = { w: 1000, h: 600 };
      const image = { w: 400, h: 200 };
      const off = centeredOffset(host, image, 1);
      // (1000-400)/2 = 300, (600-200)/2 = 200.
      expect(off).toEqual({ x: 300, y: 200 });
      // And the resulting frame round-trips a centred image-space pixel.
      const frame: ZoomFrame = { scale: 1, offset: off };
      const middleImg = { x: image.w / 2, y: image.h / 2 };
      const projected = {
        x: middleImg.x * frame.scale + frame.offset.x,
        y: middleImg.y * frame.scale + frame.offset.y,
      };
      expect(projected).toEqual({ x: host.w / 2, y: host.h / 2 });
    });
  });
});
