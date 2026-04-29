import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";

/**
 * v3.2 Issue 1 — the canvas must NOT refit when an asset's presigned URL
 * is re-signed (assetQ refetch on window focus). The pre-fix behaviour:
 * the texture-swap effect keyed `autoFitRef = true` on every successful
 * texture load → a new URL string for the same asset silently dropped
 * the user's zoom. The fix gates the autoFit re-arm on `assetId !==
 * prevAssetIdRef.current`.
 *
 * Test shape mirrors `canvas-autofit-on-asset-change.test.tsx` — the
 * lastFrame ref captures the most recent (scale, offset) applied by the
 * canvas through the FakeContainer's position.set / scale.set hooks.
 */

const { initCount, assetsLoadMock, lastFrame } = vi.hoisted(() => ({
  initCount: { value: 0 },
  assetsLoadMock: vi.fn(async (_url: string) => ({
    width: 1000,
    height: 500,
    source: { width: 1000, height: 500 },
  })),
  lastFrame: {
    value: {
      scale: 1,
      offset: { x: 0, y: 0 },
    },
  },
}));

vi.mock("pixi.js", () => {
  class FakeContainer {
    children: unknown[] = [];
    position = {
      x: 0,
      y: 0,
      set: (x: number, y: number) => {
        (this as unknown as { position: { x: number; y: number } }).position.x = x;
        (this as unknown as { position: { x: number; y: number } }).position.y = y;
        lastFrame.value = {
          scale: lastFrame.value.scale,
          offset: { x, y },
        };
      },
    };
    scale = {
      x: 1,
      y: 1,
      set: (x: number, _y: number) => {
        (this as unknown as { scale: { x: number; y: number } }).scale.x = x;
        (this as unknown as { scale: { x: number; y: number } }).scale.y = _y;
        lastFrame.value = {
          scale: x,
          offset: { ...lastFrame.value.offset },
        };
      },
    };
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
    destroy = vi.fn(() => undefined);
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
    await new Promise((r) => setTimeout(r, 50));
  });
}

afterEach(() => {
  cleanup();
});

describe("AnnotationCanvas — no refit on URL re-sign (v3.2 Issue 1)", () => {
  beforeEach(() => {
    initCount.value = 0;
    assetsLoadMock.mockClear();
    lastFrame.value = { scale: 1, offset: { x: 0, y: 0 } };
    useTool.getState().setActive("cursor");
    useTool.getState().setActiveClassId(null);
    useAnnotations.getState().reset([]);

    // Two assets at clearly different sizes so the fit-frames are
    // distinguishable. Asset A always returns 1000x500, asset B 200x200.
    assetsLoadMock.mockImplementation(async (url: string) => {
      if (url.includes("/B.")) {
        return {
          width: 200,
          height: 200,
          source: { width: 200, height: 200 },
        };
      }
      return {
        width: 1000,
        height: 500,
        source: { width: 1000, height: 500 },
      };
    });
  });

  it("re-rendering with a different URL but the SAME assetId does NOT refit (zoom preserved)", async () => {
    // Arrange — render asset A under presigned URL #1.
    const { container, rerender } = render(
      <AnnotationCanvas
        imageUrl="https://fake/A.png?sig=signature-1"
        frameId={null}
        assetId="asset-A"
      />,
    );
    await flushAsync();

    // Patch host bounding-rect so the wheel handler has finite geometry.
    const host = container.firstElementChild as HTMLElement | null;
    if (host) {
      Object.defineProperty(host, "getBoundingClientRect", {
        configurable: true,
        value: () => ({
          width: 800,
          height: 600,
          left: 0,
          top: 0,
          right: 800,
          bottom: 600,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        }),
      });

      // Simulate the user wheel-zooming. This flips autoFitRef → false
      // inside the canvas. The exact resulting scale doesn't matter — we
      // capture it as the "user's zoom" baseline.
      const wheelEvt = new WheelEvent("wheel", {
        deltaY: -100,
        bubbles: true,
        cancelable: true,
        clientX: 200,
        clientY: 200,
      });
      host.dispatchEvent(wheelEvt);
      await flushAsync();
    }

    const userZoomScale = lastFrame.value.scale;
    expect(Number.isFinite(userZoomScale)).toBe(true);
    expect(userZoomScale).toBeGreaterThan(0);

    // Act — same assetId, different URL string (simulates a presigned
    // URL re-sign on assetQ refetch / window focus).
    rerender(
      <AnnotationCanvas
        imageUrl="https://fake/A.png?sig=signature-2"
        frameId={null}
        assetId="asset-A"
      />,
    );
    await flushAsync();

    // Both URL re-sign loads should have hit Assets.load (the texture
    // does swap — only the autoFit re-arm should be skipped).
    const urls = assetsLoadMock.mock.calls.map((c) => c[0]);
    expect(urls).toContain("https://fake/A.png?sig=signature-1");
    expect(urls).toContain("https://fake/A.png?sig=signature-2");

    // Assert — the user's zoom scale must be preserved. Without the fix
    // the texture-swap effect would set autoFitRef = true, the next
    // host/image-size pass would refit asset A's 1000x500 to the host,
    // and lastFrame.scale would clamp to that fit-to-host value (which
    // is generally != the wheel-driven scale).
    expect(lastFrame.value.scale).toBe(userZoomScale);
  });

  it("re-rendering with a different assetId DOES refit (correct refit on real asset change)", async () => {
    // Arrange — start on asset A under URL #1.
    const { container, rerender } = render(
      <AnnotationCanvas
        imageUrl="https://fake/A.png?sig=signature-1"
        frameId={null}
        assetId="asset-A"
      />,
    );
    await flushAsync();

    const host = container.firstElementChild as HTMLElement | null;
    if (host) {
      Object.defineProperty(host, "getBoundingClientRect", {
        configurable: true,
        value: () => ({
          width: 800,
          height: 600,
          left: 0,
          top: 0,
          right: 800,
          bottom: 600,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        }),
      });
      // Wheel-zoom asset A so autoFitRef goes false.
      const wheelEvt = new WheelEvent("wheel", {
        deltaY: -100,
        bubbles: true,
        cancelable: true,
        clientX: 200,
        clientY: 200,
      });
      host.dispatchEvent(wheelEvt);
      await flushAsync();
    }

    const userZoomScale = lastFrame.value.scale;
    expect(Number.isFinite(userZoomScale)).toBe(true);

    // Act — navigate to a *different* asset (different assetId AND
    // different URL). The 200x200 size is intentionally distinguishable
    // so the fit-to-host frame is provably not the wheel-driven frame.
    rerender(
      <AnnotationCanvas
        imageUrl="https://fake/B.png?sig=signature-1"
        frameId={null}
        assetId="asset-B"
      />,
    );
    await flushAsync();

    // Assert — applyFrame fired for B and lastFrame is finite + positive.
    // We don't pin the exact value (jsdom layout signals are limited)
    // but a successful refit means the canvas re-applied a frame; the
    // companion existing test `canvas-autofit-on-asset-change.test.tsx`
    // already covers the strict "refit happened" path. Here we
    // additionally assert that Assets.load was hit for the new URL.
    const urls = assetsLoadMock.mock.calls.map((c) => c[0]);
    expect(urls).toContain("https://fake/B.png?sig=signature-1");
    expect(Number.isFinite(lastFrame.value.scale)).toBe(true);
    expect(lastFrame.value.scale).toBeGreaterThan(0);
    void userZoomScale;
  });
});
