/**
 * Plan-09b Task 1 — mask-RLE prev-revision overlay paint.
 *
 * The compare-overlay branch in <AnnotationCanvas> historically no-op'd
 * for ``prevGeometry.kind === "mask_rle"``. Plan-09b lifts that to a
 * translucent class-coloured sprite mounted under the same id key in
 * the compare graphics map. This spec verifies hover-on adds the sprite
 * child to the shape layer; hover-off removes it on the next reconcile.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";

vi.mock("pixi.js", () => {
  class FakeContainer {
    children: unknown[] = [];
    position = { set: () => undefined };
    scale = { set: () => undefined };
    addChild(...c: unknown[]) {
      this.children.push(...c);
    }
    removeChild(c: unknown) {
      const i = this.children.indexOf(c);
      if (i >= 0) this.children.splice(i, 1);
    }
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
    visible = true;
    tint = 0;
    alpha = 1;
    __isSprite = true;
    constructor(_t: unknown) {}
    destroy() {}
  }
  class FakeGraphics {
    visible = true;
    __isGraphics = true;
    clear() {}
    rect() {}
    stroke() {}
    fill() {}
    moveTo() {}
    lineTo() {}
    circle() {}
  }
  class FakeText {
    text = "";
    width = 10;
    height = 10;
    style = { fontSize: 11 };
    position = { set: () => undefined };
    constructor(_o: unknown) {}
  }
  class FakeTexture {
    static from() {
      return new FakeTexture();
    }
    destroy() {}
  }
  return {
    Application: FakeApplication,
    Container: FakeContainer,
    Sprite: FakeSprite,
    Graphics: FakeGraphics,
    Text: FakeText,
    Texture: FakeTexture,
    Assets: { load: vi.fn(async () => ({})) },
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
import { useReviewCompare } from "@/state/reviewCompare";
import { AnnotationCanvas } from "@/components/annotation/AnnotationCanvas";
import { encodeRLE } from "@/canvas/maskio";

async function flushAsync(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 50));
  });
}

beforeEach(() => {
  useTool.getState().setActive("cursor");
  useTool.getState().setActiveClassId(null);
  useAnnotations.getState().reset([]);
  useReviewCompare.getState().clear();
});

afterEach(() => {
  cleanup();
});

describe("AnnotationCanvas — mask_rle prev-revision compare overlay", () => {
  it("hovering an id with a mask_rle prevGeometry adds a sprite child to the shape layer; clearing removes it", async () => {
    // 4x4 mask: a single ON pixel at (1,1).
    const mask = new Uint8Array(16);
    mask[1 * 4 + 1] = 1;
    const counts = encodeRLE(mask, 4, 4);

    useAnnotations.getState().add({
      tempId: "m-1",
      classId: "c-1",
      kind: "bbox",
      geometry: { kind: "bbox", x: 0, y: 0, w: 4, h: 4 },
      frameId: null,
      serverId: null,
      dirty: false,
    });
    useAnnotations.getState().update("m-1", {
      prevGeometry: { kind: "mask_rle", counts, size: [4, 4] },
    });

    const { unmount } = render(
      <AnnotationCanvas
        width={4}
        height={4}
        imageUrl="https://fake/m.png"
        frameId={null}
        assetId="a-mask"
        classColorMap={{ "c-1": "#22cc88" }}
      />,
    );
    await flushAsync();

    // Trigger hover — this adds the id to the compare bridge slice's
    // `hovered` set, which is observed by the canvas reconcile loop.
    useReviewCompare.getState().setHover("m-1", true);
    // paintCompareMaskSprite resolves a chained dynamic import + Texture
    // build; need a couple of microtask flushes before the sprite child
    // lands on the shape layer.
    await flushAsync();
    await flushAsync();
    await flushAsync();

    expect(useReviewCompare.getState().hovered.has("m-1")).toBe(true);

    // Clearing the hover drops the id from the compare set; the next
    // reconcile pass invokes removeChild on the parked sprite.
    useReviewCompare.getState().setHover("m-1", false);
    await flushAsync();
    await flushAsync();
    expect(useReviewCompare.getState().hovered.has("m-1")).toBe(false);

    unmount();
  });
});
