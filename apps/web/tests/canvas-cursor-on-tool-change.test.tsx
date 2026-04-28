import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";

/**
 * Item 5 (v2.7 wave 2) - "when I press v and B the mouse cursor Icon
 * stuck to old one". Audit at /tmp/v27-wave2-item5-audit.md.
 *
 * The dragCursor state was only cleared inside the cursor-tool's onMove
 * branch. Switching to bbox / polygon / mask while still hovering a
 * resize handle left dragCursor as 'ew-resize', which overrode
 * toolCursor(tool) until the user wiggled the mouse with the cursor
 * tool re-active. This test pins the fix: tool change MUST reset
 * dragCursor to null so the host inline-style cursor reflects the
 * new tool.
 */

vi.mock("pixi.js", () => {
  class FakeContainer {
    children: unknown[] = [];
    position = { set: () => undefined };
    scale = { set: () => undefined };
    addChild(...c: unknown[]) {
      this.children.push(...c);
    }
    removeChild() {}
  }
  class FakeApplication {
    stage = new FakeContainer();
    canvas = document.createElement("canvas");
    renderer = { resize: () => undefined };
    init = vi.fn(async () => {});
    destroy = vi.fn();
  }
  class FakeSprite {
    width = 100;
    height = 50;
    constructor(_t: unknown) {}
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
    Assets: { load: vi.fn(async () => ({})) },
  };
});

vi.mock("@/canvas/ShapeRenderer", () => ({
  renderBbox: vi.fn(),
  renderPolygon: vi.fn(),
  BBOX_HANDLE_SIZE_PX: 8,
  BBOX_HANDLE_NAMES: ["nw", "ne", "se", "sw", "n", "e", "s", "w"],
  getBboxHandlePositions: (b: { x: number; y: number; w: number; h: number }) => [
    { name: "nw", cx: b.x, cy: b.y },
    { name: "ne", cx: b.x + b.w, cy: b.y },
    { name: "se", cx: b.x + b.w, cy: b.y + b.h },
    { name: "sw", cx: b.x, cy: b.y + b.h },
    { name: "n", cx: b.x + b.w / 2, cy: b.y },
    { name: "e", cx: b.x + b.w, cy: b.y + b.h / 2 },
    { name: "s", cx: b.x + b.w / 2, cy: b.y + b.h },
    { name: "w", cx: b.x, cy: b.y + b.h / 2 },
  ],
  cursorForHandle: () => "ew-resize",
}));

// bboxEdit hit-test must report a handle at the simulated point so
// the cursor tool's pointer-move handler sets dragCursor.
vi.mock("@/canvas/bboxEdit", () => ({
  applyResize: (orig: unknown) => orig,
  applyTranslate: (orig: unknown) => orig,
  hitTestHandle: () => "e",
  pointInsideBbox: () => false,
}));

import { useTool } from "@/state/tool";
import { useAnnotations } from "@/state/annotations";
import { AnnotationCanvas } from "@/components/annotation/AnnotationCanvas";

async function flushAsync(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 30));
  });
}

afterEach(() => {
  cleanup();
});

describe("Item 5 - cursor unsticks when active tool changes", () => {
  beforeEach(() => {
    useTool.getState().setActive("cursor");
    useTool.getState().setActiveClassId(null);
    useAnnotations.getState().reset([]);
  });

  it("switching tool from cursor (with dragCursor set on hover) to bbox flips host.style.cursor to crosshair", async () => {
    useAnnotations.getState().add({
      tempId: "t-stuck-1",
      classId: "c-1",
      kind: "bbox",
      geometry: { kind: "bbox", x: 0, y: 0, w: 50, h: 30 },
      frameId: null,
      serverId: null,
      dirty: true,
    });
    useAnnotations.getState().select("t-stuck-1");

    const { container } = render(
      <AnnotationCanvas
        width={200}
        height={120}
        imageUrl="https://fake/a.png"
        frameId={null}
        assetId="a-stuck"
        classColorMap={{ "c-1": "#ff0000" }}
      />,
    );
    await flushAsync();

    const host = container.querySelector(".canvas-checker") as HTMLElement;
    expect(host).not.toBeNull();

    // Simulate hovering a handle - the cursor-tool's onMove branch
    // calls setDragCursor("ew-resize") via cursorForHandle (mocked).
    act(() => {
      fireEvent.pointerMove(host, { clientX: 50, clientY: 15 });
    });
    await flushAsync();

    expect(host.style.cursor).toBe("ew-resize");

    // Now flip the tool to bbox. Without the fix dragCursor stays
    // "ew-resize" and overrides toolCursor("bbox") = "crosshair".
    act(() => {
      useTool.getState().setActive("bbox");
    });
    await flushAsync();

    expect(host.style.cursor).toBe("crosshair");
  });

  it("cycling cursor -> polygon -> sam -> cursor never gets stuck on a stale dragCursor", async () => {
    useAnnotations.getState().add({
      tempId: "t-stuck-2",
      classId: "c-1",
      kind: "bbox",
      geometry: { kind: "bbox", x: 0, y: 0, w: 50, h: 30 },
      frameId: null,
      serverId: null,
      dirty: true,
    });
    useAnnotations.getState().select("t-stuck-2");

    const { container } = render(
      <AnnotationCanvas
        width={200}
        height={120}
        imageUrl="https://fake/a.png"
        frameId={null}
        assetId="a-stuck-2"
        classColorMap={{ "c-1": "#ff0000" }}
      />,
    );
    await flushAsync();
    const host = container.querySelector(".canvas-checker") as HTMLElement;
    act(() => {
      fireEvent.pointerMove(host, { clientX: 50, clientY: 15 });
    });
    await flushAsync();
    expect(host.style.cursor).toBe("ew-resize");

    act(() => {
      useTool.getState().setActive("polygon");
    });
    await flushAsync();
    expect(host.style.cursor).toBe("crosshair");

    act(() => {
      useTool.getState().setActive("sam");
    });
    await flushAsync();
    expect(host.style.cursor).toBe("cell");

    act(() => {
      useTool.getState().setActive("cursor");
    });
    await flushAsync();
    expect(host.style.cursor).toBe("default");
  });
});
