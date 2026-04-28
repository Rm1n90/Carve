import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";

// Track Pixi Application.init invocations + Assets.load invocations across
// the test. v2.5 perf fix asserts that navigating between asset URLs only
// initialises Pixi ONCE — the sprite's texture is swapped instead of the
// whole Application being torn down.
//
// `vi.hoisted` lets us declare values that are visible inside the hoisted
// `vi.mock` factory below without crashing on the temporal-dead-zone error
// you get from referencing a regular top-level `const` from the factory.
const { initCount, destroyCount, assetsLoadMock } = vi.hoisted(() => ({
  initCount: { value: 0 },
  destroyCount: { value: 0 },
  assetsLoadMock: vi.fn(async (_url: string) => ({})),
}));

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
    init = vi.fn(async () => {
      initCount.value += 1;
    });
    destroy = vi.fn(() => {
      destroyCount.value += 1;
    });
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
      load: assetsLoadMock,
      unload: vi.fn(async () => undefined),
    },
  };
});

// Stub the heavy ShapeRenderer + edit helpers — we only care about the
// Pixi mount lifecycle here, not annotation rendering.
vi.mock("@/canvas/ShapeRenderer", () => ({
  renderBbox: vi.fn(),
  renderPolygon: vi.fn(),
  BBOX_HANDLE_SIZE_PX: 8,
  BBOX_HANDLE_NAMES: ["nw", "ne", "se", "sw", "n", "e", "s", "w"],
  getBboxHandlePositions: () => [],
  cursorForHandle: () => "default",
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

describe("AnnotationCanvas — Pixi lifecycle across imageUrl changes (v2.5)", () => {
  beforeEach(() => {
    initCount.value = 0;
    destroyCount.value = 0;
    assetsLoadMock.mockClear();
    useTool.getState().setActive("cursor");
    useTool.getState().setActiveClassId(null);
    useAnnotations.getState().reset([]);
  });

  it("calls Application.init only ONCE when imageUrl changes (sprite/texture swap, no remount)", async () => {
    const { rerender } = render(
      <AnnotationCanvas
        width={100}
        height={50}
        imageUrl="https://fake/A.png"
        frameId={null}
        assetId="a-1"
      />,
    );
    await flushAsync();

    const initAfterFirst = initCount.value;
    expect(initAfterFirst).toBe(1);
    expect(assetsLoadMock).toHaveBeenCalledWith("https://fake/A.png");

    // Navigate to a different asset URL — the canonical reproduction of
    // the bug being fixed.
    rerender(
      <AnnotationCanvas
        width={100}
        height={50}
        imageUrl="https://fake/B.png"
        frameId={null}
        assetId="a-2"
      />,
    );
    await flushAsync();

    // The Pixi Application MUST stay alive across the URL change. Init
    // count should still be 1; only Assets.load was called again to
    // fetch the new texture.
    expect(initCount.value).toBe(1);
    expect(destroyCount.value).toBe(0);
    expect(assetsLoadMock).toHaveBeenCalledWith("https://fake/B.png");
    // Two distinct URLs => two Assets.load calls.
    const urls = assetsLoadMock.mock.calls.map((c) => c[0]);
    expect(urls).toContain("https://fake/A.png");
    expect(urls).toContain("https://fake/B.png");
  });

  it("destroys the Pixi Application on full unmount (cleanup contract preserved)", async () => {
    const { unmount } = render(
      <AnnotationCanvas
        width={100}
        height={50}
        imageUrl="https://fake/A.png"
        frameId={null}
        assetId="a-1"
      />,
    );
    await flushAsync();
    expect(initCount.value).toBe(1);
    expect(destroyCount.value).toBe(0);

    unmount();
    await flushAsync();
    expect(destroyCount.value).toBe(1);
  });
});
