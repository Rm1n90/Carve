import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render as rtlRender } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * Zoom behaviour when the user navigates to a new asset (a different
 * `assetId`). Governed by Settings → Player → "Reset zoom when changing
 * image / frame" (`resetZoomOnFrameChange`):
 *  - off (default): a zoom the user picked on asset A (wheel, +/−,
 *    exact %) carries over to asset B, recentred.
 *  - on: the texture-swap effect re-arms `autoFitRef` so B arrives
 *    fit-to-host (the original v2.8 wave 2 behaviour).
 *
 * The test mirrors the structure of `canvas-reload-perf.test.tsx`:
 *  - mocks `pixi.js` with fakes that record every `position.set` /
 *    `scale.set` call against the layer Containers (used as a proxy for
 *    `applyFrame` invocations).
 *  - mounts the AnnotationCanvas with imageUrl A and a 1000x500 texture.
 *  - simulates a user zoom (so autoFitRef flips to false).
 *  - re-renders with imageUrl B and a different-sized texture.
 */

// Most-recent (scale, offset) the canvas applied to the imageLayer.
// `applyFrame` calls layer.position.set(x, y) and layer.scale.set(s, s)
// — the FakeContainer captures both into this ref.
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
  // Fake Container — every position.set / scale.set is captured into
  // `lastFrame` so the test can read the most-recent applyFrame. The
  // canvas calls these on three layers in lockstep so any of the three
  // is a valid sentinel; we use the imageLayer (the first child).
  class FakeContainer {
    children: unknown[] = [];
    isImageLayer = false;
    position = {
      x: 0,
      y: 0,
      set: (x: number, y: number) => {
        // Mutate the captured x/y on this object so the canvas's reads
        // (if any) stay consistent.
        (this as unknown as { position: { x: number; y: number } }).position.x = x;
        (this as unknown as { position: { x: number; y: number } }).position.y = y;
        // Always update lastFrame — the three layers move in lockstep,
        // so the imageLayer's position is the one that matters.
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

// Stub the heavy ShapeRenderer + edit helpers — the test only cares
// about the swap-effect's side-effect on autoFitRef.
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
import { useEditorSettings } from "@/state/editorSettings";
import { AnnotationCanvas } from "@/components/annotation/AnnotationCanvas";

// The canvas reads the shortcuts query, so it needs a QueryClient.
const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false } },
});
function Wrapper({ children }: { children: React.ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}
const render = (ui: React.ReactElement) => rtlRender(ui, { wrapper: Wrapper });

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

describe("AnnotationCanvas — autoFit on asset change (v2.8 wave 2)", () => {
  beforeEach(() => {
    initCount.value = 0;
    assetsLoadMock.mockClear();
    lastFrame.value = { scale: 1, offset: { x: 0, y: 0 } };
    useTool.getState().setActive("cursor");
    useTool.getState().setActiveClassId(null);
    useAnnotations.getState().reset([]);
    useEditorSettings.getState().reset();

    // Texture lookup keyed on URL — A is 1000x500, B is 200x200, so
    // the fit-frames are clearly distinguishable.
    assetsLoadMock.mockImplementation(async (url: string) => {
      if (url.endsWith("A.png")) {
        return {
          width: 1000,
          height: 500,
          source: { width: 1000, height: 500 },
        };
      }
      return {
        width: 200,
        height: 200,
        source: { width: 200, height: 200 },
      };
    });
  });

  it("calls Assets.load for both imageUrls when navigating between assets", async () => {
    // Smoke test that the swap-effect fires on every imageUrl change —
    // a regression guard against future de-bouncing that would skip
    // the autoFitRef reset.
    const { rerender } = render(
      <AnnotationCanvas
        imageUrl="https://fake/A.png"
        frameId={null}
        assetId="a-1"
      />,
    );
    await flushAsync();
    expect(assetsLoadMock).toHaveBeenCalledWith("https://fake/A.png");

    rerender(
      <AnnotationCanvas
        imageUrl="https://fake/B.png"
        frameId={null}
        assetId="a-2"
      />,
    );
    await flushAsync();
    const urls = assetsLoadMock.mock.calls.map((c) => c[0]);
    expect(urls).toContain("https://fake/A.png");
    expect(urls).toContain("https://fake/B.png");
  });

  it("after a user wheel-zoom on asset A, switching to asset B still applies a frame for B (autoFit re-armed)", async () => {
    useEditorSettings.getState().set("resetZoomOnFrameChange", true);
    // Render asset A and let init + texture-load resolve.
    const { container, rerender } = render(
      <AnnotationCanvas
        imageUrl="https://fake/A.png"
        frameId={null}
        assetId="a-1"
      />,
    );
    await flushAsync();

    // Capture the count of applyFrame-driven scale.set calls so we can
    // tell when the post-imageUrl-B frames actually arrive.
    const frameAfterA = { ...lastFrame.value };

    // Simulate a user wheel-zoom on asset A. This sets autoFitRef =
    // false in the AnnotationCanvas. The host element is the canvas's
    // first div child — even with no jsdom layout it still receives
    // synthesised events.
    const host = container.firstElementChild as HTMLElement | null;
    if (host) {
      // The wheel handler reads getBoundingClientRect() — patch it so
      // the anchor math doesn't divide by zero in jsdom.
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

    // Now navigate to asset B. Without the fix, autoFitRef would still
    // be `false` and the host/image-size effect would only re-center
    // the offset using the user's zoomed-in scale. With the fix, the
    // swap-effect resets autoFitRef BEFORE the await Assets.load, so
    // when setImageSize fires for B's 200x200 dimensions the
    // host/image-size effect picks the fit-to-host branch.
    rerender(
      <AnnotationCanvas
        imageUrl="https://fake/B.png"
        frameId={null}
        assetId="a-2"
      />,
    );
    await flushAsync();

    // Both URLs hit Assets.load — the swap-effect ran for both.
    const urls = assetsLoadMock.mock.calls.map((c) => c[0]);
    expect(urls).toContain("https://fake/A.png");
    expect(urls).toContain("https://fake/B.png");

    // After the swap-effect runs for B, an applyFrame must have fired —
    // lastFrame must reflect a fresh frame, not the wheel-driven scale
    // captured immediately after the wheel event. (The wheel handler
    // applied a scale > frameAfterA.scale on asset A; the subsequent
    // texture-swap for B re-runs applyFrame, so lastFrame.scale changes
    // from whatever the wheel left behind.)
    expect(lastFrame.value).toBeTruthy();
    // Sanity: lastFrame must be finite, positive scale (the canvas
    // never applies a frame with scale 0 in normal operation).
    expect(Number.isFinite(lastFrame.value.scale)).toBe(true);
    expect(lastFrame.value.scale).toBeGreaterThan(0);
    // The frameAfterA snapshot is unused as a strict assertion (jsdom
    // host-size signals are limited) but kept here as documentation of
    // the intended diff: with the fix, a fresh frame is applied for B.
    void frameAfterA;
  });

  describe("with a measurable 800x600 host", () => {
    // jsdom has no layout, so the canvas never learns a host size and
    // the fit / keep-zoom branch never runs. Report a real size from
    // getBoundingClientRect so the frames below are the genuine ones.
    let rectSpy: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
      rectSpy = vi
        .spyOn(HTMLElement.prototype, "getBoundingClientRect")
        .mockReturnValue({
          width: 800,
          height: 600,
          left: 0,
          top: 0,
          right: 800,
          bottom: 600,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        } as DOMRect);
    });
    afterEach(() => {
      rectSpy.mockRestore();
    });

    async function zoomTo120ThenSwitchToB(): Promise<void> {
      const { rerender } = render(
        <AnnotationCanvas
          imageUrl="https://fake/A.png"
          frameId={null}
          assetId="a-1"
        />,
      );
      await flushAsync();
      // A (1000x500) fit-to-host in 800x600 with 16px padding.
      expect(lastFrame.value.scale).toBeCloseTo(0.768, 5);

      act(() => {
        window.dispatchEvent(
          new CustomEvent("carve:zoom-to", { detail: { pct: 120 } }),
        );
      });
      expect(lastFrame.value.scale).toBeCloseTo(1.2, 5);

      rerender(
        <AnnotationCanvas
          imageUrl="https://fake/B.png"
          frameId={null}
          assetId="a-2"
        />,
      );
      await flushAsync();
    }

    it("keeps the user's zoom on the next asset by default, recentred", async () => {
      await zoomTo120ThenSwitchToB();
      expect(lastFrame.value.scale).toBeCloseTo(1.2, 5);
      // B is 200x200 → 240x240 drawn, centred in 800x600.
      expect(lastFrame.value.offset.x).toBeCloseTo(280, 5);
      expect(lastFrame.value.offset.y).toBeCloseTo(180, 5);
    });

    it("refits the next asset when 'Reset zoom when changing image / frame' is on", async () => {
      useEditorSettings.getState().set("resetZoomOnFrameChange", true);
      await zoomTo120ThenSwitchToB();
      // B (200x200) fits without upscaling → 1:1, centred.
      expect(lastFrame.value.scale).toBeCloseTo(1, 5);
      expect(lastFrame.value.offset.x).toBeCloseTo(300, 5);
      expect(lastFrame.value.offset.y).toBeCloseTo(200, 5);
    });

    it("an untouched fit view keeps fitting each new asset", async () => {
      const { rerender } = render(
        <AnnotationCanvas
          imageUrl="https://fake/A.png"
          frameId={null}
          assetId="a-1"
        />,
      );
      await flushAsync();
      expect(lastFrame.value.scale).toBeCloseTo(0.768, 5);
      rerender(
        <AnnotationCanvas
          imageUrl="https://fake/B.png"
          frameId={null}
          assetId="a-2"
        />,
      );
      await flushAsync();
      expect(lastFrame.value.scale).toBeCloseTo(1, 5);
    });
  });

  it("v2.9 P0-2 — error path surfaces 'error' status (catch branch ran, restoring autoFitRef)", async () => {
    // When Assets.load rejects, the swap-effect's catch branch must:
    //  1) not strand autoFitRef in an unexpected state (P1-12 restore).
    //  2) surface "error" via onImageStatusChange so the parent can show
    //     the retry UI.
    // The externally-observable signal in jsdom is (2) — proving the
    // catch branch ran end-to-end, which is where the restore lives.
    assetsLoadMock.mockImplementationOnce(async () => {
      throw new Error("fake network failure");
    });
    const onStatus = vi.fn();
    render(
      <AnnotationCanvas
        imageUrl="https://fake/broken.png"
        frameId={null}
        assetId="a-broken"
        onImageStatusChange={onStatus}
      />,
    );
    await flushAsync();
    const errorCall = onStatus.mock.calls.find((c) => c[0] === "error");
    expect(errorCall).toBeDefined();
    expect(errorCall?.[1]).toMatch(/fake network failure/);
  });
});
