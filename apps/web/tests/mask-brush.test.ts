import { describe, expect, it, beforeEach } from "vitest";
import { useAnnotations } from "@/state/annotations";
import { MaskBrushTool } from "@/canvas/tools/MaskBrushTool";

describe("MaskBrushTool", () => {
  beforeEach(() => useAnnotations.getState().reset([]));

  it("commits a mask annotation after Enter", () => {
    let n = 0;
    const tool = new MaskBrushTool(
      () => "c-1", () => null, () => ({ w: 32, h: 32 }), 4, () => `t-${++n}`,
    );
    tool.onPointerDown({ x: 16, y: 16 });
    tool.onPointerMove({ x: 18, y: 18 });
    tool.onPointerUp({ x: 18, y: 18 });
    const r = tool.onKeyDown("Enter");
    expect(r.committed).toBe(true);
    const drafts = Object.values(useAnnotations.getState().byId);
    expect(drafts).toHaveLength(1);
    expect(drafts[0].kind).toBe("mask");
    const g = drafts[0].geometry as any;
    expect(g.size).toEqual([32, 32]);
    expect(typeof g.counts).toBe("string");
  });

  it("Escape cancels without committing", () => {
    const tool = new MaskBrushTool(
      () => "c-1", () => null, () => ({ w: 8, h: 8 }), 2,
    );
    tool.onPointerDown({ x: 4, y: 4 });
    tool.onKeyDown("Escape");
    expect(Object.keys(useAnnotations.getState().byId)).toHaveLength(0);
  });

  it("eraser clears painted pixels and an empty commit is rejected", () => {
    let n = 0;
    const tool = new MaskBrushTool(
      () => "c-1", () => null, () => ({ w: 8, h: 8 }), 2, () => `t-${++n}`,
    );
    tool.onPointerDown({ x: 4, y: 4 });
    tool.setEraser(true);
    // Erase the painted region by laying a large eraser circle over it.
    tool.onPointerDown({ x: 4, y: 4 });
    const r = tool.onKeyDown("Enter");
    // Mask is empty after eraser → nothing committed (no useful mask).
    expect(r.committed).toBe(false);
    expect(Object.keys(useAnnotations.getState().byId)).toHaveLength(0);
  });

  it("[ and ] adjust the brush radius by 5px", () => {
    const tool = new MaskBrushTool(
      () => "c-1", () => null, () => ({ w: 16, h: 16 }), 25,
    );
    expect(tool.getRadius()).toBe(25);
    tool.onKeyDown("]");
    expect(tool.getRadius()).toBe(30);
    tool.onKeyDown("[");
    tool.onKeyDown("[");
    expect(tool.getRadius()).toBe(20);
  });

  it("right-mouse button paints an eraser stroke", () => {
    const tool = new MaskBrushTool(
      () => "c-1", () => null, () => ({ w: 16, h: 16 }), 4,
    );
    // First paint with left button to seed pixels.
    tool.onPointerDown({ x: 8, y: 8 }, 0);
    tool.onPointerUp({ x: 8, y: 8 });
    expect(tool.getRasterizer()?.hasAnyPixel()).toBe(true);
    // Then right-click drag to erase.
    tool.onPointerDown({ x: 8, y: 8 }, 2);
    tool.onPointerUp({ x: 8, y: 8 });
    expect(tool.getRasterizer()?.hasAnyPixel()).toBe(false);
  });
});
