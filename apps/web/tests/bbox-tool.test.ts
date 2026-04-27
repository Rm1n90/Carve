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
});
