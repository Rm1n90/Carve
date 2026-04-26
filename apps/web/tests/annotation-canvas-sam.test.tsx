import React from "react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act, render } from "@testing-library/react";

// Mock pixi.js heavily so jsdom doesn't choke on WebGL.
vi.mock("pixi.js", () => {
  class FakeContainer {
    children: unknown[] = [];
    addChild(...c: unknown[]) {
      this.children.push(...c);
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
    constructor(_t: unknown) {}
  }
  return {
    Application: FakeApplication,
    Container: FakeContainer,
    Sprite: FakeSprite,
    Assets: { load: vi.fn(async () => ({})) },
  };
});

vi.mock("@/api/sam", () => ({
  samApi: {
    encode: vi
      .fn()
      .mockResolvedValue({ image_hash: "h".repeat(32), shape: [10, 10] }),
    decode: vi
      .fn()
      .mockResolvedValue({ counts: "0,2", size: [4, 4], score: 0.9 }),
  },
}));

import { samApi } from "@/api/sam";
import { useTool } from "@/state/tool";
import { AnnotationCanvas } from "@/components/annotation/AnnotationCanvas";

async function flushAsync(): Promise<void> {
  // Two microtask ticks + one short macrotask flush so the fire-and-forget
  // `void samTool.activate()` resolves before the assertion fires.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 10));
  });
}

describe("AnnotationCanvas — SAM tool wiring", () => {
  beforeEach(() => {
    useTool.getState().setActive("cursor");
    useTool.getState().setActiveClassId("c-1");
    vi.clearAllMocks();
  });

  afterEach(() => {
    useTool.getState().setActive("cursor");
  });

  it("activating the sam tool calls samApi.encode with the asset id", async () => {
    const { container } = render(
      <AnnotationCanvas
        width={100}
        height={50}
        imageUrl="https://fake/a.png"
        frameId={null}
        assetId="a-1"
      />,
    );

    // Sanity: a host div was rendered.
    expect(container.firstChild).toBeTruthy();

    // Switch to sam — this is what the toolbar would do on hotkey/click.
    act(() => {
      useTool.getState().setActive("sam");
    });

    await flushAsync();
    expect(samApi.encode).toHaveBeenCalledWith("a-1");
  });

  it("a left pointerdown on the canvas (after activation) calls samApi.decode", async () => {
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
    expect(samApi.encode).toHaveBeenCalledWith("a-1");

    const host = container.firstChild as HTMLElement;
    expect(host).toBeTruthy();

    // jsdom doesn't define PointerEvent globally, but it does dispatch
    // generic Events and the canvas listener accepts MouseEvent shape
    // (button/clientX/clientY). Build a MouseEvent and dispatch under the
    // "pointerdown" type so the host's listener fires.
    await act(async () => {
      const ev = new MouseEvent("pointerdown", {
        bubbles: true,
        cancelable: true,
        button: 0,
        clientX: 5,
        clientY: 6,
      });
      host.dispatchEvent(ev);
      // Allow the awaited samApi.decode call inside SamTool.addClick to flush.
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(samApi.decode).toHaveBeenCalledTimes(1);
    const args = (samApi.decode as ReturnType<typeof vi.fn>).mock.calls[0];
    // Args: (assetId, imageHash, points, labels). We only care that the
    // asset id flows through, the hash matches the encode result, and a
    // single positive-label click is sent.
    expect(args[0]).toBe("a-1");
    expect(args[1]).toBe("h".repeat(32));
    expect(args[2]).toHaveLength(1);
    expect(args[3]).toEqual([1]);
  });
});
