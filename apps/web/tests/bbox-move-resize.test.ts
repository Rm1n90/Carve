/**
 * Tests for bbox move/resize utilities (audit bug 2 / B).
 *
 * The pure math in `canvas/bboxEdit.ts` is the load-bearing piece — the
 * Canvas pointer routing is a thin wrapper that calls the same functions
 * AnnotationCanvas does. Tests cover translate, resize handles, min-size
 * clamp, hit-testing, and the ArrowKey nudge through the store.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { useAnnotations, type AnnotationDraft, type Bbox } from "@/state/annotations";
import {
  applyResize,
  applyTranslate,
  hitTestHandle,
  MIN_BBOX_SIZE,
  pointInsideBbox,
} from "@/canvas/bboxEdit";

function makeBbox(x: number, y: number, w: number, h: number): Bbox {
  return { kind: "bbox", x, y, w, h };
}

function seedDraft(geometry: Bbox): AnnotationDraft {
  return {
    tempId: "ann-1",
    classId: "c-1",
    kind: "bbox",
    geometry,
    frameId: "f-1",
    serverId: "s-1",
    dirty: false,
  };
}

describe("bbox translate", () => {
  beforeEach(() => {
    useAnnotations.getState().reset([]);
  });

  it("moves x and y; preserves w and h", () => {
    const before = makeBbox(10, 20, 100, 80);
    const after = applyTranslate(before, 60, 70);
    expect(after).toEqual({ kind: "bbox", x: 60, y: 70, w: 100, h: 80 });
  });

  it("simulating drag-translate advances geometry.x by 50 and marks dirty", () => {
    // Arrange — seed an existing bbox in the store and simulate the drag
    // pipeline (pointerdown captures original; pointermove calls
    // applyTranslate; useAnnotations.update() flips dirty).
    const before = makeBbox(100, 100, 50, 50);
    useAnnotations.getState().reset([seedDraft(before)]);
    expect(useAnnotations.getState().byId["ann-1"].dirty).toBe(false);

    // Act — drag interior. dragOffset = (10, 5), cursor moves +50 in x.
    const dragOffset = { x: 10, y: 5 };
    const cursorAfter = { x: 100 + dragOffset.x + 50, y: 100 + dragOffset.y };
    const next = applyTranslate(
      before,
      cursorAfter.x - dragOffset.x,
      cursorAfter.y - dragOffset.y,
    );
    useAnnotations.getState().update("ann-1", { geometry: next });

    // Assert
    const updated = useAnnotations.getState().byId["ann-1"];
    expect((updated.geometry as Bbox).x).toBe(150);
    expect((updated.geometry as Bbox).y).toBe(100);
    expect(updated.dirty).toBe(true);
  });
});

describe("bbox resize", () => {
  beforeEach(() => {
    useAnnotations.getState().reset([]);
  });

  it("resize SE: pointermove +30/+20 grows w and h, anchors NW", () => {
    const before = makeBbox(100, 100, 50, 50);
    useAnnotations.getState().reset([seedDraft(before)]);
    // SE handle is at (150, 150). Cursor moves to (180, 170) → +30/+20.
    const next = applyResize(before, "se", { x: 180, y: 170 });
    useAnnotations.getState().update("ann-1", { geometry: next });
    const g = useAnnotations.getState().byId["ann-1"].geometry as Bbox;
    expect(g.x).toBe(100);
    expect(g.y).toBe(100);
    expect(g.w).toBe(80);
    expect(g.h).toBe(70);
  });

  it("resize NW: pointermove +10/+5 advances x/y and shrinks w/h, anchors SE", () => {
    const before = makeBbox(100, 100, 50, 50);
    useAnnotations.getState().reset([seedDraft(before)]);
    // NW handle is at (100, 100). Cursor moves to (110, 105) → +10/+5.
    const next = applyResize(before, "nw", { x: 110, y: 105 });
    useAnnotations.getState().update("ann-1", { geometry: next });
    const g = useAnnotations.getState().byId["ann-1"].geometry as Bbox;
    expect(g.x).toBe(110);
    expect(g.y).toBe(105);
    expect(g.w).toBe(40); // 100+50 - 110 = 40
    expect(g.h).toBe(45); // 100+50 - 105 = 45
  });

  it("min-size clamp: dragging SE into the NW corner keeps the bbox at 4×4", () => {
    const before = makeBbox(100, 100, 50, 50);
    // Cursor goes way past NW corner — past origin, even.
    const next = applyResize(before, "se", { x: -10, y: -10 });
    expect(next.x).toBe(100); // anchor preserved
    expect(next.y).toBe(100);
    expect(next.w).toBe(MIN_BBOX_SIZE);
    expect(next.h).toBe(MIN_BBOX_SIZE);
  });

  it("min-size clamp on NW: dragging past SE keeps bbox at 4×4 with SE anchored", () => {
    const before = makeBbox(100, 100, 50, 50);
    // Cursor far past SE corner.
    const next = applyResize(before, "nw", { x: 200, y: 200 });
    // SE corner stayed at (150, 150) — width/height clamped to MIN.
    expect(next.x + next.w).toBe(150);
    expect(next.y + next.h).toBe(150);
    expect(next.w).toBe(MIN_BBOX_SIZE);
    expect(next.h).toBe(MIN_BBOX_SIZE);
  });

  it("edge-only resize N moves only y/h, keeps x and w", () => {
    const before = makeBbox(100, 100, 50, 50);
    const next = applyResize(before, "n", { x: 999, y: 80 });
    expect(next.x).toBe(100);
    expect(next.w).toBe(50);
    expect(next.y).toBe(80);
    expect(next.h).toBe(70);
  });
});

describe("bbox handle hit-test", () => {
  it("hits the SE handle when cursor is within halo of (x+w, y+h)", () => {
    const b = makeBbox(100, 100, 50, 50);
    expect(hitTestHandle(b, { x: 150, y: 150 })).toBe("se");
    expect(hitTestHandle(b, { x: 151, y: 149 })).toBe("se");
  });

  it("returns null when cursor is well outside any handle halo", () => {
    const b = makeBbox(100, 100, 50, 50);
    expect(hitTestHandle(b, { x: 130, y: 130 })).toBeNull();
  });

  it("hits the NW corner handle preferentially over edges", () => {
    const b = makeBbox(100, 100, 50, 50);
    expect(hitTestHandle(b, { x: 100, y: 100 })).toBe("nw");
  });
});

describe("pointInsideBbox", () => {
  it("returns true for interior points", () => {
    const b = makeBbox(0, 0, 100, 100);
    expect(pointInsideBbox(b, { x: 50, y: 50 })).toBe(true);
  });

  it("returns false for points outside", () => {
    const b = makeBbox(0, 0, 100, 100);
    expect(pointInsideBbox(b, { x: 150, y: 50 })).toBe(false);
  });
});

describe("keyboard nudge through the store", () => {
  beforeEach(() => {
    useAnnotations.getState().reset([]);
  });

  it("ArrowRight with selection moves by 1px", () => {
    const before = makeBbox(100, 100, 50, 50);
    useAnnotations.getState().reset([seedDraft(before)]);
    const next = applyTranslate(before, before.x + 1, before.y);
    useAnnotations.getState().update("ann-1", { geometry: next });
    const g = useAnnotations.getState().byId["ann-1"].geometry as Bbox;
    expect(g.x).toBe(101);
    expect(g.y).toBe(100);
    expect(useAnnotations.getState().byId["ann-1"].dirty).toBe(true);
  });

  it("Shift+ArrowRight moves by 10px", () => {
    const before = makeBbox(100, 100, 50, 50);
    useAnnotations.getState().reset([seedDraft(before)]);
    const next = applyTranslate(before, before.x + 10, before.y);
    useAnnotations.getState().update("ann-1", { geometry: next });
    const g = useAnnotations.getState().byId["ann-1"].geometry as Bbox;
    expect(g.x).toBe(110);
  });
});

// v2.5.2 — coordinates must never escape the image. Translate clamps the
// resulting top-left so the bbox never sticks out past the image edge.
// Resize clamps the cursor before computing edges.
describe("image-bounds clamping (v2.5.2)", () => {
  it("translate: bbox at (90,50,w=20,h=20) on 100x100 + dx=+50 sticks at (80,50)", () => {
    // Bbox fully inside the 100x100 image. Drag attempts to move x to 140
    // but the right-edge constraint (max x = imageW - w = 80) holds the
    // bbox at x=80. y is unchanged since it's already in range.
    const before = makeBbox(90, 50, 20, 20);
    const next = applyTranslate(before, 140, 50, { w: 100, h: 100 });
    expect(next.x).toBe(80);
    expect(next.y).toBe(50);
    expect(next.w).toBe(20);
    expect(next.h).toBe(20);
  });

  it("translate: bbox at (10,10,w=20,h=20) + dx=-100 sticks at (0,10)", () => {
    const before = makeBbox(10, 10, 20, 20);
    const next = applyTranslate(before, -90, 10, { w: 100, h: 100 });
    expect(next.x).toBe(0);
    expect(next.y).toBe(10);
  });

  it("translate without bounds keeps legacy bound-agnostic behaviour", () => {
    const before = makeBbox(90, 90, 20, 20);
    const next = applyTranslate(before, 200, 200);
    expect(next.x).toBe(200);
    expect(next.y).toBe(200);
  });

  it("resize SE: cursor far past image edge clamps bbox to fit inside", () => {
    const before = makeBbox(50, 50, 20, 20);
    // Cursor (250, 250) clamps to (100, 100); SE handle anchors NW (50,50).
    const next = applyResize(before, "se", { x: 250, y: 250 }, { w: 100, h: 100 });
    expect(next.x).toBe(50);
    expect(next.y).toBe(50);
    expect(next.w).toBe(50);
    expect(next.h).toBe(50);
  });

  it("resize NW: cursor past SE corner respects min-size + bounds clamp", () => {
    // Bbox at (50, 50, w=20, h=20). NW handle dragged to (200, 200) → first
    // clamped to image (100, 100), then min-size kicks in: NW must stay
    // <= SE - MIN_BBOX_SIZE = (70 - 4, 70 - 4) = (66, 66). Final: x=66, y=66.
    const before = makeBbox(50, 50, 20, 20);
    const next = applyResize(before, "nw", { x: 200, y: 200 }, { w: 100, h: 100 });
    expect(next.x).toBe(66);
    expect(next.y).toBe(66);
    expect(next.w).toBe(4);
    expect(next.h).toBe(4);
  });

  it("resize NW: cursor past top-left clamps NW to (0,0)", () => {
    const before = makeBbox(50, 50, 20, 20);
    // Cursor (-50, -50) clamps to (0, 0); SE corner stays at (70, 70).
    const next = applyResize(before, "nw", { x: -50, y: -50 }, { w: 100, h: 100 });
    expect(next.x).toBe(0);
    expect(next.y).toBe(0);
    expect(next.w).toBe(70);
    expect(next.h).toBe(70);
  });

  it("resize without bounds keeps legacy behaviour", () => {
    const before = makeBbox(50, 50, 20, 20);
    const next = applyResize(before, "se", { x: 250, y: 250 });
    expect(next.w).toBe(200);
    expect(next.h).toBe(200);
  });
});
