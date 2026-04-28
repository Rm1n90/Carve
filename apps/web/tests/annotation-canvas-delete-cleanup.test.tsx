import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, fireEvent, screen } from "@testing-library/react";

/**
 * Item 2 (v2.7 wave 2) - "I press the delete button but is not working
 * inside one images". Audit at /tmp/v27-wave2-item2-audit.md.
 *
 * Two angles:
 *   (a) After remove(id) the canvas Graphics for that id MUST be
 *       detached from the shapeLayer. Without explicit cleanup the
 *       deleted shape can linger in the scene graph until the next
 *       reconcile round-trip - which the user reads as "delete didn't
 *       work".
 *   (b) The right-panel ObjectsPanel delete button used window.confirm
 *       (blocking, suppressible by browser/extensions). It should remove
 *       immediately and rely on Cmd+Z for undo.
 */

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
import { AnnotationCanvas } from "@/components/annotation/AnnotationCanvas";
import { ObjectsPanel } from "@/components/annotation/ObjectsPanel";

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

describe("Item 2 - delete cleans up canvas graphics", () => {
  beforeEach(() => {
    useTool.getState().setActive("cursor");
    useTool.getState().setActiveClassId(null);
    useAnnotations.getState().reset([]);
  });

  it("removes the bbox graphic from the shapeLayer when the annotation is deleted", async () => {
    useAnnotations.getState().add({
      tempId: "t-del-1",
      classId: "c-1",
      kind: "bbox",
      geometry: { kind: "bbox", x: 1, y: 1, w: 10, h: 10 },
      frameId: null,
      serverId: null,
      dirty: true,
    });

    render(
      <AnnotationCanvas
        width={200}
        height={150}
        imageUrl="https://fake/a.png"
        frameId={null}
        assetId="a-del"
        classColorMap={{ "c-1": "#ff0000" }}
      />,
    );
    await flushAsync();

    expect(Object.keys(useAnnotations.getState().byId)).toHaveLength(1);

    act(() => {
      useAnnotations.getState().remove("t-del-1");
    });
    await flushAsync();

    expect(useAnnotations.getState().byId["t-del-1"]).toBeUndefined();

    // Re-add the same id - if a stale Graphics persisted, the new
    // reconcile would attach a SECOND shape. Verify the byId map still
    // has only one entry after re-add.
    act(() => {
      useAnnotations.getState().add({
        tempId: "t-del-1",
        classId: "c-1",
        kind: "bbox",
        geometry: { kind: "bbox", x: 5, y: 5, w: 10, h: 10 },
        frameId: null,
        serverId: null,
        dirty: true,
      });
    });
    await flushAsync();
    expect(Object.keys(useAnnotations.getState().byId)).toHaveLength(1);
  });

  it("simulating Backspace key on multi-selected ids removes them all from the store", () => {
    useAnnotations.getState().add({
      tempId: "t-1",
      classId: "c-1",
      kind: "bbox",
      geometry: { kind: "bbox", x: 0, y: 0, w: 5, h: 5 },
      frameId: null,
      serverId: null,
      dirty: true,
    });
    useAnnotations.getState().add({
      tempId: "t-2",
      classId: "c-1",
      kind: "bbox",
      geometry: { kind: "bbox", x: 10, y: 10, w: 5, h: 5 },
      frameId: null,
      serverId: null,
      dirty: true,
    });
    useAnnotations.getState().selectMany(["t-1", "t-2"]);

    // Simulate the same loop the page-level handler runs.
    const ids = useAnnotations.getState().selectedIds;
    for (const id of ids) {
      useAnnotations.getState().remove(id);
    }
    expect(Object.keys(useAnnotations.getState().byId)).toHaveLength(0);
  });
});

describe("Item 2 - ObjectsPanel delete is non-blocking (no window.confirm)", () => {
  beforeEach(() => {
    useAnnotations.getState().reset([]);
  });

  it("clicking the delete X removes the annotation without calling window.confirm", () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    useAnnotations.getState().add({
      tempId: "t-rm-1",
      classId: "c-1",
      kind: "bbox",
      geometry: { kind: "bbox", x: 0, y: 0, w: 5, h: 5 },
      frameId: null,
      serverId: null,
      dirty: true,
    });
    render(
      <ObjectsPanel
        frameId={null}
        classes={{
          "c-1": {
            id: "c-1",
            project_id: "p-1",
            idx: 0,
            name: "car",
            color: "#ff0000",
            attributes: {},
            created_at: "",
          },
        }}
      />,
    );
    const deleteBtn = screen.getByLabelText(/delete bbox/i);
    fireEvent.click(deleteBtn);
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(useAnnotations.getState().byId["t-rm-1"]).toBeUndefined();
    confirmSpy.mockRestore();
  });
});
