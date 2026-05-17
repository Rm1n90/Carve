// Armin Mehri — mehri.armin@gmail.com
//
// v3.31 — UI smoke tests for the shared HierarchyResolverPanel that
// appears in the Auto-Annotate, Smart Find, and My Model dialogs.
// Verifies: gating on hierarchy presence, IoU slider visibility,
// representative-pair phrasing, and the toggle callback contract.
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { HierarchyResolverPanel } from "@/components/annotation/HierarchyResolverPanel";
import type { ClassRow } from "@/api/classes";

function cls(
  partial: Partial<ClassRow> & { id: string; name: string },
): ClassRow {
  return {
    project_id: "p-1",
    idx: 0,
    color: "#FF0000",
    attributes: {},
    text_prompt: null,
    parent_class_id: null,
    created_at: "2026-05-17T15:00:00Z",
    ...partial,
  };
}

describe("HierarchyResolverPanel", () => {
  it("disables the toggle when no class has a parent", () => {
    const classes = [
      cls({ id: "c-car", name: "Car" }),
      cls({ id: "c-racing", name: "Racing Car" }),
    ];
    render(
      <HierarchyResolverPanel
        name="t1"
        classes={classes}
        enabled={false}
        onEnabledChange={() => {}}
        iou={0.7}
        onIouChange={() => {}}
      />,
    );
    const toggle = screen.getByTestId("t1-hierarchy-toggle") as HTMLInputElement;
    expect(toggle.disabled).toBe(true);
    expect(screen.getByTestId("t1-hierarchy-hint").textContent).toMatch(
      /Add a parent class/i,
    );
  });

  it("enables the toggle and shows a representative pair when a hierarchy exists", () => {
    const classes = [
      cls({ id: "c-car", name: "Car" }),
      cls({ id: "c-racing", name: "Racing Car", parent_class_id: "c-car" }),
    ];
    render(
      <HierarchyResolverPanel
        name="t2"
        classes={classes}
        enabled
        onEnabledChange={() => {}}
        iou={0.7}
        onIouChange={() => {}}
      />,
    );
    const toggle = screen.getByTestId("t2-hierarchy-toggle") as HTMLInputElement;
    expect(toggle.disabled).toBe(false);
    expect(toggle.checked).toBe(true);
    expect(screen.getByTestId("t2-hierarchy-hint").textContent).toMatch(
      /Car/,
    );
    expect(screen.getByTestId("t2-hierarchy-hint").textContent).toMatch(
      /Racing Car/,
    );
  });

  it("renders the IoU slider when enabled and the project has hierarchies", () => {
    const classes = [
      cls({ id: "c-car", name: "Car" }),
      cls({ id: "c-racing", name: "Racing Car", parent_class_id: "c-car" }),
    ];
    render(
      <HierarchyResolverPanel
        name="t3"
        classes={classes}
        enabled
        onEnabledChange={() => {}}
        iou={0.7}
        onIouChange={() => {}}
      />,
    );
    expect(screen.getByTestId("t3-hierarchy-iou")).toBeInTheDocument();
  });

  it("hides the IoU slider when the toggle is off", () => {
    const classes = [
      cls({ id: "c-car", name: "Car" }),
      cls({ id: "c-racing", name: "Racing Car", parent_class_id: "c-car" }),
    ];
    render(
      <HierarchyResolverPanel
        name="t4"
        classes={classes}
        enabled={false}
        onEnabledChange={() => {}}
        iou={0.7}
        onIouChange={() => {}}
      />,
    );
    expect(screen.queryByTestId("t4-hierarchy-iou")).toBeNull();
  });

  it("calls onEnabledChange when the toggle is clicked", () => {
    const classes = [
      cls({ id: "c-car", name: "Car" }),
      cls({ id: "c-racing", name: "Racing Car", parent_class_id: "c-car" }),
    ];
    const onEnabledChange = vi.fn();
    render(
      <HierarchyResolverPanel
        name="t5"
        classes={classes}
        enabled={false}
        onEnabledChange={onEnabledChange}
        iou={0.7}
        onIouChange={() => {}}
      />,
    );
    fireEvent.click(screen.getByTestId("t5-hierarchy-toggle"));
    expect(onEnabledChange).toHaveBeenCalledWith(true);
  });

  it("calls onIouChange with the clamped numeric value when the slider moves", () => {
    const classes = [
      cls({ id: "c-car", name: "Car" }),
      cls({ id: "c-racing", name: "Racing Car", parent_class_id: "c-car" }),
    ];
    const onIouChange = vi.fn();
    render(
      <HierarchyResolverPanel
        name="t6"
        classes={classes}
        enabled
        onEnabledChange={() => {}}
        iou={0.7}
        onIouChange={onIouChange}
      />,
    );
    fireEvent.change(screen.getByTestId("t6-hierarchy-iou"), {
      target: { value: "0.85" },
    });
    expect(onIouChange).toHaveBeenCalledWith(0.85);
  });

  it("counts every parent-child pair in the helper text", () => {
    const classes = [
      cls({ id: "c-vehicle", name: "Vehicle" }),
      cls({ id: "c-car", name: "Car", parent_class_id: "c-vehicle" }),
      cls({
        id: "c-racing",
        name: "Racing Car",
        parent_class_id: "c-car",
      }),
      cls({ id: "c-truck", name: "Truck", parent_class_id: "c-vehicle" }),
    ];
    render(
      <HierarchyResolverPanel
        name="t7"
        classes={classes}
        enabled
        onEnabledChange={() => {}}
        iou={0.7}
        onIouChange={() => {}}
      />,
    );
    expect(screen.getByTestId("t7-hierarchy-hint").textContent).toMatch(
      /3 hierarchies active/i,
    );
  });
});
