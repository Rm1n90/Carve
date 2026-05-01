import { describe, expect, it, beforeEach } from "vitest";
import { MaskRasterizer } from "@/canvas/MaskRasterizer";
import { MaskBrushTool } from "@/canvas/tools/MaskBrushTool";
import { useAnnotations } from "@/state/annotations";

/**
 * Plan 09 Task 11 — verify the per-pixel alpha curve produced by
 * `MaskRasterizer.paintBrushHardness`, plus the MaskBrushTool's
 * eraser-mode behaviour driven by the new ``maskEraser`` toggle.
 */

function readAlpha(r: MaskRasterizer, x: number, y: number): number {
  const ctx = r.getCanvas().getContext("2d") as CanvasRenderingContext2D;
  const img = ctx.getImageData(x, y, 1, 1);
  return img.data[3];
}

describe("MaskRasterizer.paintBrushHardness", () => {
  it("hardness=0 → linear ramp from centre (alpha 1) to edge (alpha 0)", () => {
    const r = new MaskRasterizer(40, 40);
    const cx = 20;
    const cy = 20;
    const radius = 10;
    r.paintBrushHardness(cx, cy, radius, 0, "draw");

    // Centre pixel — distance 0; with hardness 0 the inner radius is 0
    // and the linear ramp evaluated at d=0 yields alpha 1.0 (255).
    const aCenter = readAlpha(r, cx, cy);
    expect(aCenter).toBe(255);

    // Outer pixel — at ~80% of radius the ramp gives alpha = 1 - 0.8 =
    // 0.2 → 51. Spec asks "outer pixel alpha < 0.5" (i.e. < 128).
    const aOuter = readAlpha(r, cx + 8, cy);
    expect(aOuter).toBeLessThan(128);
    expect(aOuter).toBeGreaterThan(0);

    // Pixel beyond the radius — fully transparent.
    const aBeyond = readAlpha(r, cx + radius + 2, cy);
    expect(aBeyond).toBe(0);
  });

  it("hardness=1 → uniformly opaque inside, 0 outside (no ramp)", () => {
    const r = new MaskRasterizer(40, 40);
    const cx = 20;
    const cy = 20;
    const radius = 8;
    r.paintBrushHardness(cx, cy, radius, 1, "draw");

    expect(readAlpha(r, cx, cy)).toBe(255);
    expect(readAlpha(r, cx + 5, cy)).toBe(255); // well inside
    expect(readAlpha(r, cx + 7, cy)).toBe(255); // still inside

    // Pixel just outside the radius — fully transparent.
    expect(readAlpha(r, cx + radius + 2, cy)).toBe(0);
  });

  it("hardness=0.5 → solid core, ramp in the outer half", () => {
    const r = new MaskRasterizer(40, 40);
    const cx = 20;
    const cy = 20;
    r.paintBrushHardness(cx, cy, 10, 0.5, "draw");

    // Inside the inner radius (5) → fully opaque.
    expect(readAlpha(r, cx + 4, cy)).toBe(255);
    // In the falloff band → partial.
    const aBand = readAlpha(r, cx + 8, cy);
    expect(aBand).toBeGreaterThan(0);
    expect(aBand).toBeLessThan(255);
    // Outside → transparent.
    expect(readAlpha(r, cx + 12, cy)).toBe(0);
  });
});

describe("MaskBrushTool eraser toggle", () => {
  beforeEach(() => useAnnotations.getState().reset([]));

  it("setEraser(true) reduces alpha on a non-empty mask", () => {
    const tool = new MaskBrushTool(
      () => "c-1",
      () => null,
      () => ({ w: 40, h: 40 }),
      8,
      () => "t-1",
    );
    // Paint first — left button, eraser off → mask is non-empty.
    tool.onPointerDown({ x: 20, y: 20 }, 0);
    tool.onPointerUp({ x: 20, y: 20 });
    const r = tool.getRasterizer();
    expect(r).not.toBeNull();
    const before = readAlpha(r!, 20, 20);
    expect(before).toBeGreaterThan(0);

    // Now switch to eraser mode (left-click subtracts from mask).
    tool.setEraser(true);
    expect(tool.isErasing()).toBe(true);
    tool.onPointerDown({ x: 20, y: 20 }, 0);
    tool.onPointerUp({ x: 20, y: 20 });
    const after = readAlpha(r!, 20, 20);
    expect(after).toBeLessThan(before);
  });
});
