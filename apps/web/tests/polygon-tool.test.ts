import { describe, expect, it, beforeEach } from "vitest";
import { useAnnotations } from "@/state/annotations";
import { PolygonTool, CLOSE_RADIUS_PX } from "@/canvas/tools/PolygonTool";
import {
  subscribeToasts,
  _resetToastBusForTests,
  type ToastEvent,
} from "@/lib/toast";

describe("PolygonTool", () => {
  beforeEach(() => {
    useAnnotations.getState().reset([]);
    _resetToastBusForTests();
  });

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
    const r = tool.onPointerDown({ x: 1, y: 1 }); // within close radius of first
    expect(r.committed).toBe(true);
    expect(Object.keys(useAnnotations.getState().byId)).toHaveLength(1);
  });

  it("returns a preview payload with rubber-band cursor after first vertex", () => {
    const tool = new PolygonTool(() => "c-1", () => null);
    tool.onPointerDown({ x: 10, y: 20 });
    const r = tool.onPointerMove({ x: 50, y: 60 });
    expect(r).not.toBeNull();
    expect(r?.vertices).toEqual([{ x: 10, y: 20 }]);
    expect(r?.cursor).toEqual({ x: 50, y: 60 });
    expect(r?.closeHint).toBe(false);
  });

  it("closeHint=true when cursor is within CLOSE_RADIUS_PX of the first vertex (>=3 vertices)", () => {
    const tool = new PolygonTool(() => "c-1", () => null);
    tool.onPointerDown({ x: 0, y: 0 });
    tool.onPointerDown({ x: 50, y: 0 });
    tool.onPointerDown({ x: 50, y: 50 });
    // cursor inside the close-radius circle of the first vertex
    const inside = tool.onPointerMove({ x: CLOSE_RADIUS_PX - 1, y: 0 });
    expect(inside?.closeHint).toBe(true);
    // outside
    const outside = tool.onPointerMove({ x: CLOSE_RADIUS_PX + 50, y: 0 });
    expect(outside?.closeHint).toBe(false);
  });

  it("returns null preview when no vertices have been placed", () => {
    const tool = new PolygonTool(() => "c-1", () => null);
    expect(tool.onPointerMove({ x: 10, y: 10 })).toBeNull();
  });

  it("emits a 'Pick a class first' toast when committing without an active class", () => {
    const events: ToastEvent[] = [];
    const unsub = subscribeToasts((e) => events.push(e));
    const tool = new PolygonTool(() => null, () => null);
    tool.onPointerDown({ x: 0, y: 0 });
    tool.onPointerDown({ x: 10, y: 0 });
    tool.onPointerDown({ x: 10, y: 10 });
    const r = tool.onKeyDown("Enter");
    unsub();
    expect(r.committed).toBe(false);
    expect(events).toHaveLength(1);
    expect(events[0].variant).toBe("warning");
  });

  // v2.5.2 — vertices must never escape the image.
  describe("image-bounds clamping (v2.5.2)", () => {
    it("clamps a click outside the image to the nearest image-edge vertex", () => {
      let n = 0;
      // 100x100 image; click at (-50, 200) → clamps to (0, 100).
      const tool = new PolygonTool(
        () => "c-1",
        () => null,
        () => `t-${++n}`,
        () => ({ w: 100, h: 100 }),
      );
      tool.onPointerDown({ x: -50, y: 200 });
      tool.onPointerDown({ x: 50, y: 50 });
      tool.onPointerDown({ x: 80, y: 80 });
      tool.onKeyDown("Enter");
      const g = Object.values(useAnnotations.getState().byId)[0].geometry as any;
      // First vertex was clamped from (-50, 200) → (0, 100).
      expect(g.points[0]).toEqual([0, 100]);
      expect(g.points[1]).toEqual([50, 50]);
      expect(g.points[2]).toEqual([80, 80]);
    });

    it("clamps the rubber-band cursor preview", () => {
      const tool = new PolygonTool(
        () => "c-1",
        () => null,
        () => "t-1",
        () => ({ w: 100, h: 80 }),
      );
      tool.onPointerDown({ x: 10, y: 10 });
      const r = tool.onPointerMove({ x: 1000, y: -50 });
      expect(r).not.toBeNull();
      expect(r?.cursor).toEqual({ x: 100, y: 0 });
    });

    it("falls back to bound-agnostic behaviour when imageSize is null", () => {
      let n = 0;
      const tool = new PolygonTool(() => "c-1", () => null, () => `t-${++n}`);
      tool.onPointerDown({ x: -50, y: -50 });
      tool.onPointerDown({ x: 10, y: 0 });
      tool.onPointerDown({ x: 10, y: 10 });
      tool.onKeyDown("Enter");
      const g = Object.values(useAnnotations.getState().byId)[0].geometry as any;
      expect(g.points[0]).toEqual([-50, -50]);
    });
  });
});
