import { describe, expect, it, beforeEach } from "vitest";

import { useAnnotations } from "@/state/annotations";
import { BboxTool } from "@/canvas/tools/BboxTool";
import {
  subscribeToasts,
  _resetToastBusForTests,
  type ToastEvent,
} from "@/lib/toast";

describe("BboxTool", () => {
  beforeEach(() => {
    useAnnotations.getState().reset([]);
    _resetToastBusForTests();
  });

  it("creates one bbox after a sufficient drag", () => {
    let n = 0;
    const tool = new BboxTool(() => "c-1", () => "f-1", () => `t-${++n}`);
    tool.onPointerDown({ x: 10, y: 20 });
    tool.onPointerMove({ x: 50, y: 60 });
    const created = tool.onPointerUp({ x: 50, y: 60 });
    expect(created).toBe(true);
    const drafts = Object.values(useAnnotations.getState().byId);
    expect(drafts).toHaveLength(1);
    const g = drafts[0].geometry as any;
    expect(g.x).toBe(10);
    expect(g.y).toBe(20);
    expect(g.w).toBe(40);
    expect(g.h).toBe(40);
  });

  it("ignores tiny drags below the threshold", () => {
    const tool = new BboxTool(() => "c-1", () => null);
    tool.onPointerDown({ x: 0, y: 0 });
    tool.onPointerMove({ x: 1, y: 1 });
    const created = tool.onPointerUp({ x: 1, y: 1 });
    expect(created).toBe(false);
    expect(Object.keys(useAnnotations.getState().byId)).toHaveLength(0);
  });

  it("rejects when no active class is set", () => {
    const tool = new BboxTool(() => null, () => null);
    tool.onPointerDown({ x: 0, y: 0 });
    tool.onPointerMove({ x: 50, y: 50 });
    const created = tool.onPointerUp({ x: 50, y: 50 });
    expect(created).toBe(false);
  });

  it("emits a 'Pick a class first' toast when drawing without an active class", () => {
    const events: ToastEvent[] = [];
    const unsub = subscribeToasts((e) => events.push(e));
    const tool = new BboxTool(() => null, () => null);
    tool.onPointerDown({ x: 0, y: 0 });
    tool.onPointerMove({ x: 50, y: 50 });
    tool.onPointerUp({ x: 50, y: 50 });
    unsub();
    expect(events).toHaveLength(1);
    expect(events[0].message).toMatch(/pick a class/i);
    expect(events[0].variant).toBe("warning");
  });

  it("does NOT emit a toast for a tiny drag below the threshold", () => {
    const events: ToastEvent[] = [];
    const unsub = subscribeToasts((e) => events.push(e));
    const tool = new BboxTool(() => null, () => null);
    tool.onPointerDown({ x: 0, y: 0 });
    tool.onPointerMove({ x: 1, y: 1 });
    tool.onPointerUp({ x: 1, y: 1 });
    unsub();
    expect(events).toHaveLength(0);
  });

  it("normalises reverse drag (right→left, bottom→top)", () => {
    let n = 0;
    const tool = new BboxTool(() => "c-1", () => null, () => `t-${++n}`);
    tool.onPointerDown({ x: 100, y: 100 });
    tool.onPointerMove({ x: 20, y: 30 });
    tool.onPointerUp({ x: 20, y: 30 });
    const g = Object.values(useAnnotations.getState().byId)[0].geometry as any;
    expect(g.x).toBe(20);
    expect(g.y).toBe(30);
    expect(g.w).toBe(80);
    expect(g.h).toBe(70);
  });

  // v2.5.2 — coordinates must never escape the image. Without these clamps
  // the user could draw a "totally off topic" bbox by dragging past the
  // canvas backdrop.
  describe("image-bounds clamping (v2.5.2)", () => {
    it("clamps a drag that starts inside and ends far outside the image", () => {
      let n = 0;
      // 100x80 image; drag starts at (50,50) inside, ends at (-200, 1500) far outside.
      const tool = new BboxTool(
        () => "c-1",
        () => null,
        () => `t-${++n}`,
        () => ({ w: 100, h: 80 }),
      );
      tool.onPointerDown({ x: 50, y: 50 });
      tool.onPointerMove({ x: -200, y: 1500 });
      const created = tool.onPointerUp({ x: -200, y: 1500 });
      expect(created).toBe(true);
      const g = Object.values(useAnnotations.getState().byId)[0].geometry as any;
      // Anchor (50,50). Cursor clamped to (0, 80). Normalised -> x=0, y=50, w=50, h=30.
      expect(g.x).toBe(0);
      expect(g.y).toBe(50);
      expect(g.w).toBe(50);
      expect(g.h).toBe(30);
    });

    it("rejects a drag that lives entirely outside the image (degenerate)", () => {
      let n = 0;
      // 100x80 image; both endpoints outside top-left → both clamp to (0,0)
      // and the rectangle collapses to 0x0 → below MIN_BBOX_SIZE → rejected.
      const tool = new BboxTool(
        () => "c-1",
        () => null,
        () => `t-${++n}`,
        () => ({ w: 100, h: 80 }),
      );
      tool.onPointerDown({ x: -50, y: -50 });
      tool.onPointerMove({ x: -10, y: -10 });
      const created = tool.onPointerUp({ x: -10, y: -10 });
      expect(created).toBe(false);
      expect(Object.keys(useAnnotations.getState().byId)).toHaveLength(0);
    });

    it("rejects a tiny 3x3 bbox after clamping (below MIN_BBOX_SIZE)", () => {
      let n = 0;
      const tool = new BboxTool(
        () => "c-1",
        () => null,
        () => `t-${++n}`,
        () => ({ w: 100, h: 100 }),
      );
      // 3x3 drag (>= MIN_DRAG_PX so it isn't dropped as noise) but below
      // MIN_BBOX_SIZE = 4. The MIN_DRAG_PX gate is hypotenuse-distance
      // (3,3 → ~4.24px) so it passes that, but each edge is 3 px so the
      // bbox-size gate rejects.
      tool.onPointerDown({ x: 10, y: 10 });
      tool.onPointerMove({ x: 13, y: 13 });
      const created = tool.onPointerUp({ x: 13, y: 13 });
      expect(created).toBe(false);
      expect(Object.keys(useAnnotations.getState().byId)).toHaveLength(0);
    });

    it("falls back to bound-agnostic behaviour when imageSize is null", () => {
      let n = 0;
      // No imageSize getter → tool keeps the legacy behaviour and lets the
      // caller (or backend) handle bounds. This guards initial-mount races
      // where the image hasn't loaded yet.
      const tool = new BboxTool(() => "c-1", () => null, () => `t-${++n}`);
      tool.onPointerDown({ x: -50, y: -50 });
      tool.onPointerMove({ x: 50, y: 50 });
      const created = tool.onPointerUp({ x: 50, y: 50 });
      expect(created).toBe(true);
      const g = Object.values(useAnnotations.getState().byId)[0].geometry as any;
      expect(g.x).toBe(-50);
      expect(g.y).toBe(-50);
    });
  });
});
