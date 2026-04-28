import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { ObjectsPanel } from "@/components/annotation/ObjectsPanel";
import { ConfirmProvider } from "@/components/ui/ConfirmDialog";
import { useAnnotations } from "@/state/annotations";
import { useFilter } from "@/state/annotationFilter";
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
const CLASS_B = makeClass({
  id: "class-b",
  idx: 1,
  name: "Banana",
  color: "#00ff00",
});

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  // Reset stores so tests don't leak state.
  useAnnotations.getState().reset([]);
  useFilter.getState().clearFilter();
  useAnnotations.getState().add({
    tempId: "ann-1",
    classId: CLASS_A.id,
    kind: "bbox",
    geometry: { kind: "bbox", x: 1, y: 2, w: 10, h: 20 },
    frameId: FRAME_ID,
    serverId: null,
    dirty: false,
  });
});

describe("ObjectsPanel — change class via inline dropdown", () => {
  function renderPanel() {
    const classes: Record<string, ClassRow> = {
      [CLASS_A.id]: CLASS_A,
      [CLASS_B.id]: CLASS_B,
    };
    return render(
      <ConfirmProvider>
        <ObjectsPanel frameId={FRAME_ID} classes={classes} />
      </ConfirmProvider>,
    );
  }

  it("renders a class trigger that shows the current class name", () => {
    renderPanel();
    const trigger = screen.getByTestId("object-class-trigger-ann-1");
    expect(trigger.textContent ?? "").toContain("Apple");
  });

  it("opens the popover and lists all available classes", () => {
    renderPanel();
    fireEvent.click(screen.getByTestId("object-class-trigger-ann-1"));
    // Both classes should be present as options.
    expect(
      screen.getByTestId(`object-class-option-ann-1-${CLASS_A.id}`),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId(`object-class-option-ann-1-${CLASS_B.id}`),
    ).toBeInTheDocument();
  });

  it("reassigns the annotation classId and marks it dirty when a different class is picked", () => {
    renderPanel();
    fireEvent.click(screen.getByTestId("object-class-trigger-ann-1"));
    fireEvent.click(
      screen.getByTestId(`object-class-option-ann-1-${CLASS_B.id}`),
    );
    const updated = useAnnotations.getState().byId["ann-1"];
    expect(updated.classId).toBe(CLASS_B.id);
    expect(updated.dirty).toBe(true);
  });

  it("does not modify state when the same class is reselected (no spurious dirty bit)", () => {
    renderPanel();
    fireEvent.click(screen.getByTestId("object-class-trigger-ann-1"));
    fireEvent.click(
      screen.getByTestId(`object-class-option-ann-1-${CLASS_A.id}`),
    );
    const updated = useAnnotations.getState().byId["ann-1"];
    expect(updated.classId).toBe(CLASS_A.id);
    // The annotation was added with dirty=false; no-op should keep it that way.
    expect(updated.dirty).toBe(false);
  });

  it("after reassignment, the row shows the new class name in the trigger", () => {
    renderPanel();
    fireEvent.click(screen.getByTestId("object-class-trigger-ann-1"));
    fireEvent.click(
      screen.getByTestId(`object-class-option-ann-1-${CLASS_B.id}`),
    );
    const trigger = screen.getByTestId("object-class-trigger-ann-1");
    expect(trigger.textContent ?? "").toContain("Banana");
  });

  it("renders 'Unassigned' when the annotation references an unknown classId", () => {
    useAnnotations.getState().reset([
      {
        tempId: "ann-2",
        classId: "missing",
        kind: "bbox",
        geometry: { kind: "bbox", x: 0, y: 0, w: 1, h: 1 },
        frameId: FRAME_ID,
        serverId: null,
        dirty: false,
      },
    ]);
    render(
      <ConfirmProvider>
        <ObjectsPanel
          frameId={FRAME_ID}
          classes={{ [CLASS_A.id]: CLASS_A, [CLASS_B.id]: CLASS_B }}
        />
      </ConfirmProvider>,
    );
    const trigger = screen.getByTestId("object-class-trigger-ann-2");
    expect(trigger.textContent ?? "").toContain("Unassigned");
  });
});
