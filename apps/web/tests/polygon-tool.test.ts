import { describe, expect, it, beforeEach } from "vitest";
import { useAnnotations } from "@/state/annotations";
import { PolygonTool } from "@/canvas/tools/PolygonTool";

describe("PolygonTool", () => {
  beforeEach(() => useAnnotations.getState().reset([]));

  it("commits on Enter with 3+ vertices", () => {
    let n = 0;
    const tool = new PolygonTool(() => "c-1", () => null, () => `t-${++n}`);
    tool.onPointerDown({ x: 0, y: 0 });
    tool.onPointerDown({ x: 10, y: 0 });
    tool.onPointerDown({ x: 10, y: 10 });
    const r = tool.onKeyDown("Enter");
    expect(r.committed).toBe(true);
    const drafts = Object.values(useAnnotations.getState().byId);
    expect(drafts).toHaveLength(1);
    const g = drafts[0].geometry as any;
    expect(g.points).toEqual([[0, 0], [10, 0], [10, 10]]);
  });

  it("Enter with fewer than 3 vertices does not commit", () => {
    const tool = new PolygonTool(() => "c-1", () => null);
    tool.onPointerDown({ x: 0, y: 0 });
    tool.onPointerDown({ x: 10, y: 0 });
    const r = tool.onKeyDown("Enter");
    expect(r.committed).toBe(false);
    expect(Object.keys(useAnnotations.getState().byId)).toHaveLength(0);
  });

  it("Escape cancels and clears vertices", () => {
    const tool = new PolygonTool(() => "c-1", () => null);
    tool.onPointerDown({ x: 0, y: 0 });
    tool.onPointerDown({ x: 10, y: 0 });
    tool.onKeyDown("Escape");
    expect(tool.vertexCount()).toBe(0);
  });

  it("click on first vertex closes the polygon when >= 3 points", () => {
    let n = 0;
    const tool = new PolygonTool(() => "c-1", () => null, () => `t-${++n}`);
    tool.onPointerDown({ x: 0, y: 0 });
    tool.onPointerDown({ x: 10, y: 0 });
    tool.onPointerDown({ x: 10, y: 10 });
    const r = tool.onPointerDown({ x: 1, y: 1 }); // within 8 px of first
    expect(r.committed).toBe(true);
    expect(Object.keys(useAnnotations.getState().byId)).toHaveLength(1);
  });
});
