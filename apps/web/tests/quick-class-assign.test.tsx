/**
 * Plan 14 Phase 8 Task 5 — type-to-filter quick reassign for selected
 * annotations. Pressing a letter outside any input while ≥1 annotation
 * is selected opens the Class Command Palette in reassign mode with
 * the letter pre-filled. Numbers 1..9 retain their existing "set
 * active class N" behaviour, and modifier-letter combos (⌘A, ⌘P …)
 * are passed through.
 *
 * Pixi is mocked out — we only assert the key-routing layer in
 * AnnotationCanvas, which is decoupled from the renderer.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

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
    constructor(_t: unknown) {}
    destroy() {}
  }
  class FakeGraphics {
    visible = true;
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
import { useClassRecents } from "@/state/classRecents";
import { AnnotationCanvas } from "@/components/annotation/AnnotationCanvas";
import type { ClassRow } from "@/api/classes";

const PROJECT_ID = "p-test";

function makeClass(idx: number, name: string): ClassRow {
  return {
    id: `c-${idx}`,
    project_id: PROJECT_ID,
    idx,
    name,
    color: "#ff0000",
    attributes: {},
    created_at: "2026-01-01T00:00:00Z",
  };
}

const CLASSES: ClassRow[] = [
  makeClass(0, "Car"),
  makeClass(1, "Cat"),
  makeClass(2, "Dog"),
  makeClass(3, "Eagle"),
];

async function flushAsync(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 30));
  });
}

beforeEach(() => {
  useTool.getState().setActive("cursor");
  useTool.getState().setActiveClassId(null);
  useAnnotations.getState().reset([
    {
      tempId: "ann-1",
      classId: CLASSES[2].id,
      kind: "bbox",
      geometry: { kind: "bbox", x: 0, y: 0, w: 10, h: 10 },
      frameId: null,
      serverId: null,
      dirty: false,
    },
  ]);
  useClassRecents.setState({ pinnedByProject: {}, recentByProject: {} });
});

afterEach(() => {
  cleanup();
});

function renderCanvas() {
  return render(
    <AnnotationCanvas
      width={100}
      height={50}
      imageUrl="https://fake/a.png"
      frameId={null}
      assetId="a-1"
      classes={CLASSES}
    />,
  );
}

describe("AnnotationCanvas — type-to-filter quick reassign (Task 5)", () => {
  it("opens reassign palette with the typed letter pre-filled when an annotation is selected", async () => {
    renderCanvas();
    await flushAsync();
    useAnnotations.getState().selectMany(["ann-1"]);

    fireEvent.keyDown(window, { key: "c" });

    const palette = screen.getByTestId("class-command-palette");
    expect(palette.getAttribute("data-mode")).toBe("reassign");
    const input = screen.getByTestId(
      "class-command-palette-input",
    ) as HTMLInputElement;
    expect(input.value).toBe("c");
    const items = screen.getAllByRole("option");
    expect(items[0].textContent).toMatch(/Car/);
  });

  it("digits 1..9 do NOT open the palette (preserves 'set active class N' behaviour)", async () => {
    renderCanvas();
    await flushAsync();
    useAnnotations.getState().selectMany(["ann-1"]);

    fireEvent.keyDown(window, { key: "1" });

    expect(screen.queryByTestId("class-command-palette")).toBeNull();
  });

  it("Cmd-A on a letter does NOT open the palette (preserves select-all)", async () => {
    renderCanvas();
    await flushAsync();
    useAnnotations.getState().selectMany(["ann-1"]);

    fireEvent.keyDown(window, { key: "a", metaKey: true });

    expect(screen.queryByTestId("class-command-palette")).toBeNull();
  });

  it("letter keys with no selection do NOT open the palette", async () => {
    renderCanvas();
    await flushAsync();
    // No selection set.

    fireEvent.keyDown(window, { key: "c" });

    expect(screen.queryByTestId("class-command-palette")).toBeNull();
  });
});
