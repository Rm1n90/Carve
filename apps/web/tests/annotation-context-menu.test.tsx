import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRef } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";

import { AnnotationContextMenu } from "@/components/annotation/AnnotationContextMenu";
import { ObjectsPanel } from "@/components/annotation/ObjectsPanel";
import { ConfirmProvider } from "@/components/ui/ConfirmDialog";
import { useAnnotations, type AnnotationDraft } from "@/state/annotations";
import type { ClassRow } from "@/api/classes";

function makeClass(over: Partial<ClassRow> & Pick<ClassRow, "id">): ClassRow {
  return {
    id: over.id,
    project_id: over.project_id ?? "p-1",
    idx: over.idx ?? 0,
    name: over.name ?? "Class",
    color: over.color ?? "#ff0000",
    attributes: over.attributes ?? {},
    created_at: over.created_at ?? "2026-01-01T00:00:00Z",
  };
}

const FRAME_ID = "frame-1";

const CLASS_A = makeClass({
  id: "class-a",
  idx: 0,
  name: "Apple",
  color: "#ff0000",
});

function bbox(
  id: string,
  classId = CLASS_A.id,
  over: Partial<AnnotationDraft> = {},
): AnnotationDraft {
  return {
    tempId: id,
    classId,
    kind: "bbox",
    geometry: { kind: "bbox", x: 10, y: 20, w: 100, h: 50 },
    frameId: FRAME_ID,
    serverId: null,
    dirty: true,
    ...over,
  };
}

/**
 * Renders the context menu wrapped in a div that acts as the canvas
 * "host". The component attaches its contextmenu listener to this host
 * via the ref.
 */
function Harness({
  classes,
  hitTestResult,
}: {
  classes?: ClassRow[];
  hitTestResult: string | null;
}) {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div
      ref={ref}
      data-testid="canvas-host"
      style={{ width: 400, height: 300 }}
    >
      <AnnotationContextMenu
        hostRef={ref}
        hitTest={() => hitTestResult}
        classes={classes}
        toImageXY={(cx, cy) => ({ x: cx, y: cy })}
        frameId={FRAME_ID}
        imageBounds={{ w: 1000, h: 1000 }}
      />
    </div>
  );
}

function rightClickHost(): void {
  const host = screen.getByTestId("canvas-host");
  fireEvent.contextMenu(host, { clientX: 50, clientY: 60 });
}

beforeEach(() => {
  useAnnotations.getState().reset([]);
});

afterEach(() => {
  cleanup();
});

describe("AnnotationContextMenu — annotation hits", () => {
  beforeEach(() => {
    useAnnotations.getState().add(bbox("a-1"));
  });

  it("opens the menu with Change class on right-click over an annotation", () => {
    render(<Harness hitTestResult="a-1" />);
    rightClickHost();
    expect(screen.getByTestId("annotation-context-menu")).toBeInTheDocument();
    expect(
      screen.getByTestId("ctx-change-class-palette"),
    ).toBeInTheDocument();
  });

  it("Duplicate clones the annotation offset by (16, 16)", () => {
    render(<Harness hitTestResult="a-1" />);
    rightClickHost();
    fireEvent.click(screen.getByTestId("ctx-duplicate"));
    const drafts = Object.values(useAnnotations.getState().byId);
    expect(drafts).toHaveLength(2);
    const dup = drafts.find((d) => d.tempId !== "a-1")!;
    expect(dup.classId).toBe(CLASS_A.id);
    const g = dup.geometry as { kind: "bbox"; x: number; y: number };
    expect(g.x).toBe(26);
    expect(g.y).toBe(36);
  });

  it("Lock toggles lockedIds; locked annotations are no longer body-hit-testable", () => {
    render(<Harness hitTestResult="a-1" />);
    rightClickHost();
    fireEvent.click(screen.getByTestId("ctx-lock"));
    expect(useAnnotations.getState().lockedIds.has("a-1")).toBe(true);
    expect(useAnnotations.getState().isLocked("a-1")).toBe(true);
  });

  it("Copy populates clipboard; Paste from empty canvas creates a 2nd annotation", () => {
    const { rerender } = render(<Harness hitTestResult="a-1" />);
    rightClickHost();
    fireEvent.click(screen.getByTestId("ctx-copy"));
    expect(useAnnotations.getState().clipboard).not.toBeNull();

    rerender(<Harness hitTestResult={null} />);
    rightClickHost();
    expect(screen.getByTestId("canvas-context-menu")).toBeInTheDocument();
    const pasteBtn = screen.getByTestId("ctx-paste") as HTMLButtonElement;
    expect(pasteBtn.disabled).toBe(false);
    fireEvent.click(pasteBtn);
    expect(Object.keys(useAnnotations.getState().byId)).toHaveLength(2);
  });

  it("Change color → red sets colorOverride on the draft", () => {
    render(<Harness hitTestResult="a-1" />);
    rightClickHost();
    fireEvent.click(screen.getByTestId("ctx-change-color"));
    fireEvent.click(screen.getByTestId("ctx-color-ef4444"));
    expect(useAnnotations.getState().byId["a-1"].colorOverride).toBe(
      "#EF4444",
    );
  });

  it("Reset to class color clears the colorOverride", () => {
    useAnnotations.getState().update("a-1", { colorOverride: "#EF4444" });
    render(<Harness hitTestResult="a-1" />);
    rightClickHost();
    fireEvent.click(screen.getByTestId("ctx-change-color"));
    fireEvent.click(screen.getByTestId("ctx-color-reset"));
    expect(useAnnotations.getState().byId["a-1"].colorOverride).toBeNull();
  });

  it("Reveal in panel scrolls the Objects row into view", () => {
    const scrollSpy = vi.fn();
    HTMLElement.prototype.scrollIntoView = scrollSpy;
    render(
      <ConfirmProvider>
        <ObjectsPanel
          frameId={FRAME_ID}
          classes={{ [CLASS_A.id]: CLASS_A }}
        />
        <Harness hitTestResult="a-1" />
      </ConfirmProvider>,
    );
    rightClickHost();
    fireEvent.click(screen.getByTestId("ctx-reveal"));
    expect(scrollSpy).toHaveBeenCalled();
  });
});

describe("AnnotationContextMenu — empty canvas", () => {
  it("Paste annotation is disabled when clipboard is empty", () => {
    render(<Harness hitTestResult={null} />);
    rightClickHost();
    expect(screen.getByTestId("canvas-context-menu")).toBeInTheDocument();
    const pasteBtn = screen.getByTestId("ctx-paste") as HTMLButtonElement;
    expect(pasteBtn.disabled).toBe(true);
  });

  it("Fit to screen dispatches the carve:fit-to-screen event", () => {
    const fitSpy = vi.fn();
    window.addEventListener("carve:fit-to-screen", fitSpy);
    render(<Harness hitTestResult={null} />);
    rightClickHost();
    fireEvent.click(screen.getByTestId("ctx-fit"));
    expect(fitSpy).toHaveBeenCalled();
    window.removeEventListener("carve:fit-to-screen", fitSpy);
  });
});

describe("annotation store — Plan 14 Task 6 actions", () => {
  beforeEach(() => {
    useAnnotations.getState().reset([]);
  });

  it("toggleLock flips membership in lockedIds", () => {
    useAnnotations.getState().add(bbox("a-1"));
    expect(useAnnotations.getState().isLocked("a-1")).toBe(false);
    useAnnotations.getState().toggleLock("a-1");
    expect(useAnnotations.getState().isLocked("a-1")).toBe(true);
    useAnnotations.getState().toggleLock("a-1");
    expect(useAnnotations.getState().isLocked("a-1")).toBe(false);
  });

  it("duplicate clamps to image bounds", () => {
    useAnnotations.getState().add(
      bbox("a-1", CLASS_A.id, {
        geometry: { kind: "bbox", x: 990, y: 990, w: 50, h: 50 },
      }),
    );
    const newId = useAnnotations
      .getState()
      .duplicate("a-1", 16, 16, { w: 1000, h: 1000 });
    expect(newId).not.toBeNull();
    const dup = useAnnotations.getState().byId[newId!];
    const g = dup.geometry as { x: number; y: number; w: number; h: number };
    // 990 + 16 = 1006 → clamped to 1000-50 = 950
    expect(g.x).toBe(950);
    expect(g.y).toBe(950);
  });

  it("pasteFromClipboard returns null when clipboard is empty", () => {
    expect(useAnnotations.getState().pasteFromClipboard(0, 0)).toBeNull();
  });

  it("pasteFromClipboard places at the given (x, y)", () => {
    useAnnotations.getState().add(bbox("a-1"));
    useAnnotations.getState().copyToClipboard("a-1");
    const newId = useAnnotations
      .getState()
      .pasteFromClipboard(200, 300, FRAME_ID);
    expect(newId).not.toBeNull();
    const pasted = useAnnotations.getState().byId[newId!];
    const g = pasted.geometry as { x: number; y: number };
    expect(g.x).toBe(200);
    expect(g.y).toBe(300);
    expect(pasted.frameId).toBe(FRAME_ID);
  });
});
