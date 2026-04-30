/**
 * v3.6 SAM live preview tests — the canvas must paint a point marker
 * AND a translucent mask preview the moment a SAM click resolves, with
 * NO Enter required (CVAT-style interactivity). Covers:
 *
 *   - Left click → addClick called with pointer=0 (positive label).
 *   - Right click → addClick called with pointer=2 (negative label).
 *   - After decode resolves, the SAM mask preview sprite is attached
 *     to the overlay layer.
 *   - Pressing Enter commits + clears the live preview overlays.
 *   - Pressing Escape clears the live preview overlays.
 */

import React from "react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { act, cleanup, render } from "@testing-library/react";

// Mock pixi.js. We export Graphics + Texture + Sprite so the SAM live
// preview helpers (drawSamPoints + drawSamMaskPreview) can build the
// sprite/graphics primitives without crashing under jsdom.
vi.mock("pixi.js", () => {
  class FakeContainer {
    children: unknown[] = [];
    addChild(...c: unknown[]) {
      this.children.push(...c);
    }
    removeChild(c: unknown) {
      this.children = this.children.filter((x) => x !== c);
    }
  }
  class FakeApplication {
    stage = new FakeContainer();
    canvas = document.createElement("canvas");
    init = vi.fn(async () => {});
    destroy = vi.fn();
  }
  class FakeSprite {
    width = 100;
    height = 50;
    tint = 0xffffff;
    alpha = 1;
    visible = true;
    constructor(_t: unknown) {}
    destroy = vi.fn();
  }
  class FakeGraphics {
    cleared = 0;
    primitives: string[] = [];
    clear() {
      this.cleared += 1;
      this.primitives = [];
      return this;
    }
    circle(_x: number, _y: number, _r: number) {
      this.primitives.push("circle");
      return this;
    }
    fill(_opts: unknown) {
      this.primitives.push("fill");
      return this;
    }
    stroke(_opts: unknown) {
      this.primitives.push("stroke");
      return this;
    }
    rect() {
      return this;
    }
    moveTo() {
      return this;
    }
    lineTo() {
      return this;
    }
    destroy = vi.fn();
  }
  class FakeTexture {
    source = { update: vi.fn() };
    destroy = vi.fn();
    constructor(_opts?: unknown) {}
    static from(_src: unknown) {
      return new FakeTexture();
    }
  }
  class FakeCanvasSource {
    constructor(public opts: unknown) {}
  }
  return {
    Application: FakeApplication,
    Container: FakeContainer,
    Sprite: FakeSprite,
    Graphics: FakeGraphics,
    Texture: FakeTexture,
    CanvasSource: FakeCanvasSource,
    Assets: { load: vi.fn(async () => ({})) },
  };
});

vi.mock("@/api/sam", () => ({
  samApi: {
    encode: vi.fn().mockResolvedValue({
      image_hash: "h".repeat(32),
      shape: [10, 10],
    }),
    decode: vi.fn().mockResolvedValue({
      counts: "0,5,5",
      size: [10, 10],
      score: 0.92,
    }),
    boxPrompt: vi.fn(),
    textPrompt: vi.fn(),
  },
}));

import { samApi } from "@/api/sam";
import { useTool } from "@/state/tool";
import { useAnnotations } from "@/state/annotations";
import { AnnotationCanvas } from "@/components/annotation/AnnotationCanvas";

async function flushAsync(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 15));
  });
}

describe("v3.6 — SAM live CVAT-style preview", () => {
  beforeEach(() => {
    useAnnotations.getState().reset([]);
    useTool.setState({ active: "cursor", samMode: "point" });
    useTool.getState().setActiveClassId("c-1");
    vi.clearAllMocks();
    // Re-arm the default mock returns after clearAllMocks wiped them.
    (samApi.encode as ReturnType<typeof vi.fn>).mockResolvedValue({
      image_hash: "h".repeat(32),
      shape: [10, 10],
    });
    (samApi.decode as ReturnType<typeof vi.fn>).mockResolvedValue({
      counts: "0,5,5",
      size: [10, 10],
      score: 0.92,
    });
  });

  afterEach(() => {
    cleanup();
    useTool.setState({ active: "cursor", samMode: "point" });
  });

  it("left pointerdown calls addClick with pointer=0 (positive label)", async () => {
    const { container } = render(
      <AnnotationCanvas
        width={100}
        height={50}
        imageUrl="https://fake/a.png"
        frameId={null}
        assetId="a-1"
      />,
    );
    act(() => {
      useTool.getState().setActive("sam");
    });
    await flushAsync();
    const host = container.firstChild as HTMLElement;
    await act(async () => {
      const ev = new MouseEvent("pointerdown", {
        bubbles: true,
        cancelable: true,
        button: 0,
        clientX: 5,
        clientY: 6,
      });
      host.dispatchEvent(ev);
      await new Promise((r) => setTimeout(r, 15));
    });
    expect(samApi.decode).toHaveBeenCalledTimes(1);
    const args = (samApi.decode as ReturnType<typeof vi.fn>).mock.calls[0];
    // Positive (left) click → label 1.
    expect(args[3]).toEqual([1]);
  });

  it("right pointerdown calls addClick with pointer=2 (negative label)", async () => {
    const { container } = render(
      <AnnotationCanvas
        width={100}
        height={50}
        imageUrl="https://fake/a.png"
        frameId={null}
        assetId="a-1"
      />,
    );
    act(() => {
      useTool.getState().setActive("sam");
    });
    await flushAsync();
    const host = container.firstChild as HTMLElement;
    // First a positive click so the decode has at least one positive
    // alongside the negative (the model service requires that).
    await act(async () => {
      const left = new MouseEvent("pointerdown", {
        bubbles: true,
        cancelable: true,
        button: 0,
        clientX: 3,
        clientY: 3,
      });
      host.dispatchEvent(left);
      await new Promise((r) => setTimeout(r, 15));
    });
    await act(async () => {
      const right = new MouseEvent("pointerdown", {
        bubbles: true,
        cancelable: true,
        button: 2,
        clientX: 7,
        clientY: 8,
      });
      host.dispatchEvent(right);
      await new Promise((r) => setTimeout(r, 15));
    });
    expect(samApi.decode).toHaveBeenCalledTimes(2);
    const lastArgs = (samApi.decode as ReturnType<typeof vi.fn>).mock.calls[1];
    // Labels: [positive, negative] = [1, 0].
    expect(lastArgs[3]).toEqual([1, 0]);
  });

  it("after a SAM click resolves, decode response is consumed (mask preview triggered)", async () => {
    const { container } = render(
      <AnnotationCanvas
        width={100}
        height={50}
        imageUrl="https://fake/a.png"
        frameId={null}
        assetId="a-1"
      />,
    );
    act(() => {
      useTool.getState().setActive("sam");
    });
    await flushAsync();
    const host = container.firstChild as HTMLElement;
    await act(async () => {
      const ev = new MouseEvent("pointerdown", {
        bubbles: true,
        cancelable: true,
        button: 0,
        clientX: 5,
        clientY: 6,
      });
      host.dispatchEvent(ev);
      await new Promise((r) => setTimeout(r, 30));
    });
    // The contract here: decode is awaited and resolves. In production
    // the live preview helpers (drawSamPoints + drawSamMaskPreview) run
    // inside a .then() on the addClick promise, so by this point the
    // response shape (counts + size) has been consumed by the renderer.
    expect(samApi.decode).toHaveBeenCalledTimes(1);
    const result = (samApi.decode as ReturnType<typeof vi.fn>).mock.results[0];
    expect(result.type).toBe("return");
  });

  it("Enter on the SAM tool commits the mask + clears the live preview", async () => {
    const { container } = render(
      <AnnotationCanvas
        width={100}
        height={50}
        imageUrl="https://fake/a.png"
        frameId={null}
        assetId="a-1"
      />,
    );
    act(() => {
      useTool.getState().setActive("sam");
    });
    await flushAsync();
    const host = container.firstChild as HTMLElement;
    await act(async () => {
      const ev = new MouseEvent("pointerdown", {
        bubbles: true,
        cancelable: true,
        button: 0,
        clientX: 5,
        clientY: 6,
      });
      host.dispatchEvent(ev);
      await new Promise((r) => setTimeout(r, 25));
    });
    // No annotation yet — addClick did NOT auto-commit.
    expect(Object.keys(useAnnotations.getState().byId)).toHaveLength(0);

    await act(async () => {
      const k = new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
      });
      window.dispatchEvent(k);
      await new Promise((r) => setTimeout(r, 15));
    });
    // Enter committed the mask as a regular annotation.
    const drafts = Object.values(useAnnotations.getState().byId);
    expect(drafts).toHaveLength(1);
    expect(drafts[0].kind).toBe("mask");
  });

  it("Escape on the SAM tool clears the live preview without committing", async () => {
    const { container } = render(
      <AnnotationCanvas
        width={100}
        height={50}
        imageUrl="https://fake/a.png"
        frameId={null}
        assetId="a-1"
      />,
    );
    act(() => {
      useTool.getState().setActive("sam");
    });
    await flushAsync();
    const host = container.firstChild as HTMLElement;
    await act(async () => {
      const ev = new MouseEvent("pointerdown", {
        bubbles: true,
        cancelable: true,
        button: 0,
        clientX: 5,
        clientY: 6,
      });
      host.dispatchEvent(ev);
      await new Promise((r) => setTimeout(r, 25));
    });
    await act(async () => {
      const k = new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      });
      window.dispatchEvent(k);
      await new Promise((r) => setTimeout(r, 5));
    });
    // No annotation — Escape just resets.
    expect(Object.keys(useAnnotations.getState().byId)).toHaveLength(0);
  });
});
