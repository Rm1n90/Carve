import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";

/**
 * v3.2 Issue 2 — canvas pan via Space-hold + drag and middle-mouse drag.
 *
 * Pre-fix: once the user wheel-zoomed past the host bounds, there was
 * no way to scroll to the off-screen portion of the image. Wheel only
 * zooms; pointer-down was routed straight to the active tool (so a
 * "pan-drag" actually started a bbox/polygon drag).
 *
 * Fix: a `spacePanRef` flag set by a global keydown listener, plus a
 * pan branch that intercepts before tool routing — `e.button === 1`
 * (middle-mouse) and `spacePanRef.current === true` both trigger it.
 *
 * The integration test exercises:
 *   1. Space keydown flips host cursor to "grab"
 *   2. pointerdown → pointermove → pointerup translates offsetRef by
 *      approximately (dx, dy) (within a small tolerance)
 *   3. Space keyup reverts the cursor
 *   4. Middle-mouse pointerdown also pans (no Space required)
 *   5. Space typed into a text input does NOT activate pan (target
 *      check)
 */

const { lastFrame } = vi.hoisted(() => ({
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
      load: vi.fn(async () => ({
        width: 1000,
        height: 800,
        source: { width: 1000, height: 800 },
      })),
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

function attachHostRect(host: HTMLElement, w = 800, h = 600): void {
  Object.defineProperty(host, "getBoundingClientRect", {
    configurable: true,
    value: () => ({
      width: w,
      height: h,
      left: 0,
      top: 0,
      right: w,
      bottom: h,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }),
  });
}

/**
 * jsdom doesn't define `PointerEvent` globally and fireEvent.pointerXxx
 * loses init fields on some node versions. We build a `MouseEvent` and
 * dispatch under the `pointerdown` / `pointermove` / `pointerup` types
 * so the canvas's native listener (which only reads
 * `button`/`clientX`/`clientY`/`pointerId`) fires correctly.
 *
 * Mirrors `tests/annotation-canvas-sam.test.tsx`.
 */
function dispatchPointer(
  el: EventTarget,
  type: "pointerdown" | "pointermove" | "pointerup",
  init: { button?: number; clientX: number; clientY: number; pointerId?: number },
): void {
  const ev = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    button: init.button ?? 0,
    clientX: init.clientX,
    clientY: init.clientY,
  });
  // pointerId is read off the event in setPointerCapture / releasePointerCapture
  // calls. Patch it on so jsdom's MouseEvent doesn't throw on access.
  Object.defineProperty(ev, "pointerId", {
    configurable: true,
    value: init.pointerId ?? 1,
  });
  el.dispatchEvent(ev);
}

afterEach(() => {
  cleanup();
});

describe("AnnotationCanvas — pan via Space-drag + middle-mouse (v3.2 Issue 2)", () => {
  beforeEach(() => {
    lastFrame.value = { scale: 1, offset: { x: 0, y: 0 } };
    useTool.getState().setActive("cursor");
    useTool.getState().setActiveClassId(null);
    useAnnotations.getState().reset([]);
  });

  it("Space keydown flips host cursor to 'grab' (no drag yet)", async () => {
    const { container } = render(
      <AnnotationCanvas
        imageUrl="https://fake/A.png"
        frameId={null}
        assetId="a-pan-1"
      />,
    );
    await flushAsync();

    const host = container.querySelector(".canvas-checker") as HTMLElement;
    expect(host).not.toBeNull();
    attachHostRect(host);

    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { code: "Space", key: " " }));
    });
    await flushAsync();

    expect(host.style.cursor).toBe("grab");

    // Release — cursor should revert.
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keyup", { code: "Space", key: " " }));
    });
    await flushAsync();

    expect(host.style.cursor).not.toBe("grab");
  });

  it("Space + drag translates the layer offset by ~(dx, dy)", async () => {
    const { container } = render(
      <AnnotationCanvas
        imageUrl="https://fake/A.png"
        frameId={null}
        assetId="a-pan-2"
      />,
    );
    await flushAsync();

    const host = container.querySelector(".canvas-checker") as HTMLElement;
    attachHostRect(host);

    // Capture the baseline offset (post fit-to-host).
    const before = { ...lastFrame.value.offset };

    // Arm pan with Space.
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { code: "Space", key: " " }));
    });
    await flushAsync();

    // pointerdown → pointermove(dx=50, dy=30) → pointerup
    act(() => {
      dispatchPointer(host, "pointerdown", {
        clientX: 100,
        clientY: 100,
        button: 0,
        pointerId: 1,
      });
    });
    act(() => {
      dispatchPointer(host, "pointermove", {
        clientX: 150,
        clientY: 130,
        button: 0,
        pointerId: 1,
      });
    });
    await flushAsync();

    // Cursor mid-drag should be 'grabbing'.
    expect(host.style.cursor).toBe("grabbing");

    // Offset should have moved by approximately (50, 30) within 1px.
    const after = lastFrame.value.offset;
    expect(Math.abs(after.x - (before.x + 50))).toBeLessThanOrEqual(1);
    expect(Math.abs(after.y - (before.y + 30))).toBeLessThanOrEqual(1);

    act(() => {
      dispatchPointer(host, "pointerup", {
        clientX: 150,
        clientY: 130,
        button: 0,
        pointerId: 1,
      });
    });
    await flushAsync();

    // Space still held → cursor reverts to 'grab'.
    expect(host.style.cursor).toBe("grab");

    // Release Space → cursor reverts.
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keyup", { code: "Space", key: " " }));
    });
    await flushAsync();
    expect(host.style.cursor).not.toBe("grab");
    expect(host.style.cursor).not.toBe("grabbing");
  });

  it("middle-mouse drag pans without requiring Space", async () => {
    const { container } = render(
      <AnnotationCanvas
        imageUrl="https://fake/A.png"
        frameId={null}
        assetId="a-pan-3"
      />,
    );
    await flushAsync();

    const host = container.querySelector(".canvas-checker") as HTMLElement;
    attachHostRect(host);

    const before = { ...lastFrame.value.offset };

    // No Space — go straight to a middle-button (button === 1) drag.
    act(() => {
      dispatchPointer(host, "pointerdown", {
        clientX: 200,
        clientY: 150,
        button: 1,
        pointerId: 2,
      });
    });
    act(() => {
      dispatchPointer(host, "pointermove", {
        clientX: 220,
        clientY: 160,
        button: 1,
        pointerId: 2,
      });
    });
    await flushAsync();

    expect(host.style.cursor).toBe("grabbing");
    const after = lastFrame.value.offset;
    expect(Math.abs(after.x - (before.x + 20))).toBeLessThanOrEqual(1);
    expect(Math.abs(after.y - (before.y + 10))).toBeLessThanOrEqual(1);

    act(() => {
      dispatchPointer(host, "pointerup", {
        clientX: 220,
        clientY: 160,
        button: 1,
        pointerId: 2,
      });
    });
    await flushAsync();
    // No Space held → cursor reverts to default tool cursor.
    expect(host.style.cursor).not.toBe("grabbing");
  });

  it("Space pressed inside a text input does NOT activate pan", async () => {
    const { container } = render(
      <div>
        <input data-testid="search" defaultValue="" />
        <AnnotationCanvas
          imageUrl="https://fake/A.png"
          frameId={null}
          assetId="a-pan-4"
        />
      </div>,
    );
    await flushAsync();

    const host = container.querySelector(".canvas-checker") as HTMLElement;
    attachHostRect(host);
    const input = container.querySelector(
      "[data-testid=search]",
    ) as HTMLInputElement;

    const cursorBefore = host.style.cursor;

    // Dispatch keydown with the input as target — the canvas's pan
    // listener must early-return on INPUT/TEXTAREA/contenteditable.
    act(() => {
      input.focus();
      const evt = new KeyboardEvent("keydown", {
        code: "Space",
        key: " ",
        bubbles: true,
      });
      input.dispatchEvent(evt);
    });
    await flushAsync();

    // Cursor should remain whatever it was before — NOT 'grab'.
    expect(host.style.cursor).toBe(cursorBefore);
    expect(host.style.cursor).not.toBe("grab");
  });
});
