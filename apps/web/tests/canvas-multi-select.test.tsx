import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

/**
 * Plan 14 Phase 8 Task 7 — canvas marquee multi-select + bulk class
 * reassign. Five behaviours are covered:
 *
 *   1. Marquee selects a subset of annotations on the current frame.
 *   2. Shift-marquee unions with the existing selection.
 *   3. Locked annotations are excluded from marquee selection.
 *   4. ``setActiveClassForSelected`` flips all selected drafts' classId
 *      in ONE history step (single undo entry, not N).
 *   5. The multi-select status chip renders only when ``selectedIds.length > 1``.
 */

vi.mock("pixi.js", () => {
  class FakeContainer {
    children: unknown[] = [];
    position = { x: 0, y: 0, set() {} };
    scale = { x: 1, y: 1, set() {} };
    addChild(...c: unknown[]) {
      this.children.push(...c);
    }
    removeChild() {}
  }
  class FakeApplication {
    stage = new FakeContainer();
    canvas = document.createElement("canvas");
    renderer = { resize() {} };
    init = vi.fn(async () => {});
    destroy = vi.fn();
  }
  class FakeSprite {
    width = 100;
    height = 50;
    texture: unknown;
    constructor(t: unknown) {
      this.texture = t;
    }
  }
  class FakeGraphics {
    clear() {}
    rect() {}
    stroke() {}
    fill() {}
    moveTo() {}
    lineTo() {}
    circle() {}
    visible = true;
  }
  return {
    Application: FakeApplication,
    Container: FakeContainer,
    Sprite: FakeSprite,
    Graphics: FakeGraphics,
    Assets: {
      load: vi.fn(async () => ({ width: 100, height: 50 })),
      unload: vi.fn(async () => undefined),
    },
  };
});

vi.mock("@/canvas/ShapeRenderer", () => ({
  renderBbox: vi.fn(),
  renderPolygon: vi.fn(),
  BBOX_HANDLE_SIZE_PX: 8,
  BBOX_HANDLE_NAMES: ["nw", "ne", "se", "sw", "n", "e", "s", "w"],
  getBboxHandlePositions: () => [],
  cursorForHandle: () => "default",
}));

import { useAnnotations } from "@/state/annotations";
import { useTool } from "@/state/tool";
import {
  AnnotationCanvas,
  marqueeHitTest,
} from "@/components/annotation/AnnotationCanvas";

afterEach(() => {
  cleanup();
});

interface BboxLite {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  classId?: string;
}

function seedBboxes(items: BboxLite[], frameId: string | null = null): void {
  for (const it of items) {
    useAnnotations.getState().add({
      tempId: it.id,
      classId: it.classId ?? "c-1",
      kind: "bbox",
      geometry: { kind: "bbox", x: it.x, y: it.y, w: it.w, h: it.h },
      frameId,
      serverId: null,
      dirty: true,
    });
  }
}

describe("Plan 14 Task 7 — marqueeHitTest pure helper", () => {
  beforeEach(() => {
    useAnnotations.getState().reset([]);
  });

  it("selects 3 of 5 bboxes whose AABBs overlap the marquee rect", () => {
    seedBboxes([
      { id: "a", x: 10, y: 10, w: 20, h: 20 }, // inside (10..30 x 10..30)
      { id: "b", x: 40, y: 10, w: 20, h: 20 }, // inside
      { id: "c", x: 70, y: 10, w: 20, h: 20 }, // inside
      { id: "d", x: 10, y: 200, w: 20, h: 20 }, // far below
      { id: "e", x: 200, y: 10, w: 20, h: 20 }, // far right
    ]);
    const matched = marqueeHitTest({
      byId: useAnnotations.getState().byId,
      frameId: null,
      hidden: [],
      hiddenClasses: [],
      locked: new Set<string>(),
      rect: { x1: 5, y1: 5, x2: 95, y2: 95 },
    });
    expect(matched.sort()).toEqual(["a", "b", "c"]);
  });

  it("excludes locked annotations from the marquee match", () => {
    seedBboxes([
      { id: "a", x: 10, y: 10, w: 5, h: 5 },
      { id: "b", x: 20, y: 10, w: 5, h: 5 },
      { id: "c", x: 30, y: 10, w: 5, h: 5 },
      { id: "d", x: 40, y: 10, w: 5, h: 5 },
    ]);
    useAnnotations.getState().lock("c");
    const matched = marqueeHitTest({
      byId: useAnnotations.getState().byId,
      frameId: null,
      hidden: [],
      hiddenClasses: [],
      locked: useAnnotations.getState().lockedIds,
      rect: { x1: 0, y1: 0, x2: 100, y2: 100 },
    });
    expect(matched.sort()).toEqual(["a", "b", "d"]);
  });

  it("treats any-overlap (not strict containment) as a hit", () => {
    seedBboxes([
      // straddles the right edge of the marquee — overlap, not contained.
      { id: "edge", x: 90, y: 10, w: 30, h: 10 },
    ]);
    const matched = marqueeHitTest({
      byId: useAnnotations.getState().byId,
      frameId: null,
      hidden: [],
      hiddenClasses: [],
      locked: new Set<string>(),
      rect: { x1: 0, y1: 0, x2: 100, y2: 50 },
    });
    expect(matched).toEqual(["edge"]);
  });
});

describe("Plan 14 Task 7 — setActiveClassForSelected bulk action", () => {
  beforeEach(() => {
    useAnnotations.getState().reset([]);
  });

  it("flips all selected drafts' classId and pushes EXACTLY ONE history entry", () => {
    seedBboxes([
      { id: "a", x: 0, y: 0, w: 5, h: 5, classId: "c-1" },
      { id: "b", x: 0, y: 0, w: 5, h: 5, classId: "c-1" },
      { id: "c", x: 0, y: 0, w: 5, h: 5, classId: "c-1" },
    ]);
    useAnnotations.getState().selectMany(["a", "b", "c"]);
    const beforeLen = useAnnotations.getState().history.past.length;

    useAnnotations.getState().setActiveClassForSelected("c-2");

    const afterLen = useAnnotations.getState().history.past.length;
    expect(afterLen).toBe(beforeLen + 1);

    const byId = useAnnotations.getState().byId;
    expect(byId["a"].classId).toBe("c-2");
    expect(byId["b"].classId).toBe("c-2");
    expect(byId["c"].classId).toBe("c-2");
    expect(byId["a"].dirty).toBe(true);
    expect(byId["b"].dirty).toBe(true);
    expect(byId["c"].dirty).toBe(true);
  });

  it("undo reverts the WHOLE bulk reassign in a single step", () => {
    seedBboxes([
      { id: "a", x: 0, y: 0, w: 5, h: 5, classId: "c-1" },
      { id: "b", x: 0, y: 0, w: 5, h: 5, classId: "c-1" },
    ]);
    useAnnotations.getState().selectMany(["a", "b"]);
    useAnnotations.getState().setActiveClassForSelected("c-9");
    expect(useAnnotations.getState().byId["a"].classId).toBe("c-9");
    expect(useAnnotations.getState().byId["b"].classId).toBe("c-9");

    useAnnotations.getState().undo();

    expect(useAnnotations.getState().byId["a"].classId).toBe("c-1");
    expect(useAnnotations.getState().byId["b"].classId).toBe("c-1");
  });

  it("is a no-op when no selected draft would change", () => {
    seedBboxes([{ id: "a", x: 0, y: 0, w: 5, h: 5, classId: "c-7" }]);
    useAnnotations.getState().selectMany(["a"]);
    const beforeLen = useAnnotations.getState().history.past.length;
    useAnnotations.getState().setActiveClassForSelected("c-7");
    const afterLen = useAnnotations.getState().history.past.length;
    expect(afterLen).toBe(beforeLen);
  });
});

describe("Plan 14 Task 7 — multi-select status chip", () => {
  beforeEach(() => {
    useTool.getState().setActive("cursor");
    useTool.getState().setActiveClassId(null);
    useAnnotations.getState().reset([]);
  });

  async function flushAsync(): Promise<void> {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 30));
    });
  }

  it("does not render when 0 or 1 annotations are selected", async () => {
    seedBboxes([{ id: "only", x: 0, y: 0, w: 5, h: 5 }]);
    useAnnotations.getState().select("only");

    render(
      <AnnotationCanvas
        imageUrl="https://fake/A.png"
        frameId={null}
        assetId="a-chip-1"
      />,
    );
    await flushAsync();
    expect(screen.queryByTestId("multi-select-status-chip")).toBeNull();
  });

  it("renders count + reassign / delete / clear hints when N > 1", async () => {
    seedBboxes([
      { id: "a", x: 0, y: 0, w: 5, h: 5 },
      { id: "b", x: 0, y: 0, w: 5, h: 5 },
      { id: "c", x: 0, y: 0, w: 5, h: 5 },
    ]);
    render(
      <AnnotationCanvas
        imageUrl="https://fake/A.png"
        frameId={null}
        assetId="a-chip-2"
      />,
    );
    await flushAsync();

    act(() => {
      useAnnotations.getState().selectMany(["a", "b", "c"]);
    });

    const chip = await screen.findByTestId("multi-select-status-chip");
    expect(chip.textContent).toContain("3 selected");
    expect(chip.textContent).toContain("R to reassign");
    expect(chip.textContent).toContain("Backspace to delete");
    expect(chip.textContent).toContain("Esc to clear");

    // Drop selection back to one — chip disappears.
    act(() => {
      useAnnotations.getState().select("a");
    });
    expect(screen.queryByTestId("multi-select-status-chip")).toBeNull();
  });
});

describe("Plan 14 Task 7 — shift-extends store-level union semantics", () => {
  beforeEach(() => {
    useAnnotations.getState().reset([]);
  });

  it("union = existing selection ∪ marquee match", () => {
    seedBboxes([
      { id: "a", x: 0, y: 0, w: 5, h: 5 },
      { id: "b", x: 20, y: 0, w: 5, h: 5 },
      { id: "c", x: 40, y: 0, w: 5, h: 5 },
    ]);
    // Pre-select a.
    useAnnotations.getState().select("a");
    // Marquee covers b + c.
    const matched = marqueeHitTest({
      byId: useAnnotations.getState().byId,
      frameId: null,
      hidden: [],
      hiddenClasses: [],
      locked: useAnnotations.getState().lockedIds,
      rect: { x1: 18, y1: -5, x2: 50, y2: 10 },
    });
    expect(matched.sort()).toEqual(["b", "c"]);
    // Shift-merge.
    const union = Array.from(
      new Set([...useAnnotations.getState().selectedIds, ...matched]),
    );
    useAnnotations.getState().selectMany(union);
    expect([...useAnnotations.getState().selectedIds].sort()).toEqual([
      "a",
      "b",
      "c",
    ]);
  });
});
