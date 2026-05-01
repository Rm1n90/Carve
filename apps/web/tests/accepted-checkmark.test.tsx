/**
 * Plan-09b Task 3 — accepted-status checkmark badge on the class label.
 *
 * Asserts that:
 *  - a draft with ``status: 'accepted'`` causes the label container to
 *    receive an EXTRA child (the check Graphics) on top of the bg + text,
 *  - a draft with ``status: 'proposed'`` has only bg + text — no badge.
 *
 * Captures the label Container child count by instrumenting the Pixi
 * mock's FakeContainer.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";

// Track every container created so the test can find the label
// container (the one whose first two children are a bg + a text).
// The list lives on globalThis so it's accessible from the hoisted
// vi.mock factory below — top-level closures aren't.
type AnyContainer = { children: unknown[] };
const G = globalThis as unknown as { __ACC_TEST_CONTAINERS__: AnyContainer[] };
G.__ACC_TEST_CONTAINERS__ = [];
const containers = G.__ACC_TEST_CONTAINERS__;

vi.mock("pixi.js", () => {
  const G = globalThis as unknown as { __ACC_TEST_CONTAINERS__: AnyContainer[] };
  class FakeContainer {
    children: unknown[] = [];
    position = { set: () => undefined };
    scale = { set: () => undefined };
    constructor() {
      G.__ACC_TEST_CONTAINERS__.push(this);
    }
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
    text: string;
    width = 30;
    height = 12;
    style = { fontSize: 11 };
    position = { set: () => undefined };
    __isText = true;
    constructor(opts: { text?: string }) {
      this.text = opts?.text ?? "";
    }
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
import { AnnotationCanvas } from "@/components/annotation/AnnotationCanvas";

async function flushAsync(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 50));
  });
}

/** Find the label Container — the one whose children include a Text. */
function findLabelContainer(): AnyContainer | undefined {
  return containers.find((c) =>
    c.children.some(
      (ch) => (ch as { __isText?: boolean }).__isText === true,
    ),
  );
}

beforeEach(() => {
  containers.length = 0;
  useTool.getState().setActive("cursor");
  useTool.getState().setActiveClassId(null);
  useAnnotations.getState().reset([]);
});

afterEach(() => {
  cleanup();
});

describe("AnnotationCanvas — accepted-status checkmark badge (Plan-09b Task 3)", () => {
  it("adds a 3rd child (check Graphics) to the label container when status === 'accepted'", async () => {
    useAnnotations.getState().reset([
      {
        tempId: "a-acc",
        classId: "c-1",
        kind: "bbox",
        geometry: { kind: "bbox", x: 1, y: 1, w: 10, h: 10 },
        frameId: null,
        serverId: "a-acc",
        dirty: false,
        status: "accepted",
      },
    ]);

    render(
      <AnnotationCanvas
        width={100}
        height={50}
        imageUrl="https://fake/a.png"
        frameId={null}
        assetId="a-1"
        classColorMap={{ "c-1": "#ff0000" }}
        classNameMap={{ "c-1": "Cat" }}
      />,
    );
    await flushAsync();
    await flushAsync();

    const label = findLabelContainer();
    expect(label).toBeTruthy();
    // bg (Graphics) + text (Text) + check (Graphics) → 3 children.
    expect(label!.children.length).toBe(3);
  });

  it("only has bg + text on the label container when status === 'proposed'", async () => {
    useAnnotations.getState().reset([
      {
        tempId: "a-prop",
        classId: "c-1",
        kind: "bbox",
        geometry: { kind: "bbox", x: 1, y: 1, w: 10, h: 10 },
        frameId: null,
        serverId: "a-prop",
        dirty: false,
        status: "proposed",
      },
    ]);

    render(
      <AnnotationCanvas
        width={100}
        height={50}
        imageUrl="https://fake/b.png"
        frameId={null}
        assetId="a-2"
        classColorMap={{ "c-1": "#ff0000" }}
        classNameMap={{ "c-1": "Cat" }}
      />,
    );
    await flushAsync();
    await flushAsync();

    const label = findLabelContainer();
    expect(label).toBeTruthy();
    // bg (Graphics) + text (Text) → 2 children, no check badge.
    expect(label!.children.length).toBe(2);
  });
});
