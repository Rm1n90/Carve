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

  it("eraser sets pixels to zero", () => {
    let n = 0;
    const tool = new MaskBrushTool(
      () => "c-1", () => null, () => ({ w: 8, h: 8 }), 2, () => `t-${++n}`,
    );
    tool.onPointerDown({ x: 4, y: 4 });
    tool.setEraser(true);
    tool.onPointerDown({ x: 4, y: 4 });
    tool.onKeyDown("Enter");
    // Whole mask should now be all zeros — RLE encodes it as a single run = h*w
    const g = Object.values(useAnnotations.getState().byId)[0].geometry as any;
    // For uniform-zero, counts is "64" (one run of zeros)
    const total = g.counts.split(",").map((s: string) => parseInt(s, 10)).reduce((a: number, b: number) => a + b, 0);
    expect(total).toBe(64);
  });
});
