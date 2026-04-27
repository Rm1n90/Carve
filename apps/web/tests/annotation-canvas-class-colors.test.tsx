import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, cleanup } from "@testing-library/react";

// Mock pixi.js heavily so jsdom doesn't choke on WebGL.
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

// Spy on the shape renderer so we can assert the bbox color routed through
// the prop instead of the legacy CustomEvent path.
const renderBboxSpy = vi.fn();
const renderPolygonSpy = vi.fn();
vi.mock("@/canvas/ShapeRenderer", () => ({
  renderBbox: (...args: unknown[]) => renderBboxSpy(...args),
  renderPolygon: (...args: unknown[]) => renderPolygonSpy(...args),
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

describe("AnnotationCanvas — classColorMap prop (audit bug H)", () => {
  beforeEach(() => {
    useTool.getState().setActive("cursor");
    useTool.getState().setActiveClassId(null);
    useAnnotations.getState().reset([]);
    renderBboxSpy.mockReset();
    renderPolygonSpy.mockReset();
  });

  it("forwards the prop class color (red 0xff0000) to renderBbox without relying on a CustomEvent", async () => {
    useAnnotations.getState().add({
      tempId: "t-bug-H",
      classId: "c-1",
      kind: "bbox",
      geometry: { kind: "bbox", x: 1, y: 2, w: 10, h: 20 },
      frameId: null,
      serverId: null,
      dirty: true,
    });

    render(
      <AnnotationCanvas
        width={100}
        height={50}
        imageUrl="https://fake/a.png"
        frameId={null}
        assetId="a-1"
        classColorMap={{ "c-1": "#ff0000" }}
      />,
    );
    await flushAsync();

    expect(renderBboxSpy).toHaveBeenCalled();
    const lastCall = renderBboxSpy.mock.calls[renderBboxSpy.mock.calls.length - 1];
    // Args: (graphics, bbox, color, selected)
    expect(lastCall[2]).toBe(0xff0000);
  });

  it("falls back to the default amber when no entry exists for the classId", async () => {
    useAnnotations.getState().add({
      tempId: "t-orphan",
      classId: "c-unknown",
      kind: "bbox",
      geometry: { kind: "bbox", x: 0, y: 0, w: 5, h: 5 },
      frameId: null,
      serverId: null,
      dirty: true,
    });

    render(
      <AnnotationCanvas
        width={100}
        height={50}
        imageUrl="https://fake/a.png"
        frameId={null}
        assetId="a-2"
        classColorMap={{ "c-1": "#ff0000" }}
      />,
    );
    await flushAsync();

    expect(renderBboxSpy).toHaveBeenCalled();
    const lastCall = renderBboxSpy.mock.calls[renderBboxSpy.mock.calls.length - 1];
    expect(lastCall[2]).toBe(0xeab308);
  });
});
