import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";

// Mock pixi.js so jsdom doesn't choke on WebGL during AnnotationCanvas mount.
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

// ShapeRenderer is imported transitively; provide the minimum surface so
// module-level constants in bboxEdit.ts resolve at import time.
vi.mock("@/canvas/ShapeRenderer", () => ({
  renderBbox: vi.fn(),
  renderPolygon: vi.fn(),
  BBOX_HANDLE_SIZE_PX: 8,
  BBOX_HANDLE_NAMES: ["nw", "ne", "se", "sw", "n", "e", "s", "w"],
  getBboxHandlePositions: () => [],
  cursorForHandle: () => "default",
}));

import { AnnotationCanvas } from "@/components/annotation/AnnotationCanvas";
import { DEFAULT_SETTINGS, useEditorSettings } from "@/state/editorSettings";

async function flushAsync(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 30));
  });
}

function renderCanvas() {
  return render(
    <AnnotationCanvas
      width={100}
      height={50}
      imageUrl="https://fake/a.png"
      frameId={null}
      assetId="a-bd"
    />,
  );
}

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  // Always start each test from a clean DEFAULT_SETTINGS slate so leak from
  // an earlier test (or persisted localStorage) cannot influence rendering.
  window.localStorage.removeItem("carve.settings.v1");
  useEditorSettings.setState({ ...DEFAULT_SETTINGS });
});

describe("AnnotationCanvas — backdrop wiring (Phase B v2.4)", () => {
  it("default canvasPattern='none' omits the data-pattern attribute", async () => {
    const { container } = renderCanvas();
    await flushAsync();
    const host = container.querySelector(".canvas-checker") as HTMLElement;
    expect(host).not.toBeNull();
    expect(host.getAttribute("data-pattern")).toBeNull();
  });

  it("setting canvasPattern='subtle' adds data-pattern=\"subtle\"", async () => {
    act(() => {
      useEditorSettings.getState().set("canvasPattern", "subtle");
    });
    const { container } = renderCanvas();
    await flushAsync();
    const host = container.querySelector(".canvas-checker") as HTMLElement;
    expect(host).not.toBeNull();
    expect(host.getAttribute("data-pattern")).toBe("subtle");
  });

  it("setting canvasBgColor applies it as inline backgroundColor", async () => {
    act(() => {
      useEditorSettings.getState().set("canvasBgColor", "#1a1a1a");
    });
    const { container } = renderCanvas();
    await flushAsync();
    const host = container.querySelector(".canvas-checker") as HTMLElement;
    expect(host).not.toBeNull();
    // jsdom serialises hex colours as `rgb(...)`.
    expect(host.style.backgroundColor.toLowerCase()).toBe(
      "rgb(26, 26, 26)",
    );
  });
});
