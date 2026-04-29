/**
 * v3.0 B2 — per-class "Clear on this frame" action.
 *
 * Asserts the new 3-dot menu on each class row exposes:
 *   - "Clear on this frame" → confirm → removes only this-frame-this-class
 *     annotations (siblings on other frames + other classes preserved).
 *   - "Delete class…" → confirm → calls `onDeleteClass(cid)` (existing flow,
 *     now reachable via the menu instead of an inline trash icon).
 *
 * Cancel branches must NOT remove anything.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { ClassesPanel } from "@/components/annotation/ClassesPanel";
import { ConfirmProvider } from "@/components/ui/ConfirmDialog";
import { useAnnotations } from "@/state/annotations";
import { useTool } from "@/state/tool";

afterEach(() => {
  cleanup();
  document.body.removeAttribute("data-scroll-locked");
  document.body.removeAttribute("style");
});

const classes = [
  { id: "cA", project_id: "p", idx: 0, name: "alpha", color: "#ff0000", attributes: {}, created_at: "" },
  { id: "cB", project_id: "p", idx: 1, name: "beta", color: "#00ff00", attributes: {}, created_at: "" },
];

function seed() {
  // 3 of class A on frame F + 2 of class A on frame G + 1 of class B on F.
  useAnnotations.getState().reset([
    { tempId: "a-F-1", classId: "cA", kind: "bbox", geometry: { kind: "bbox", x: 0, y: 0, w: 1, h: 1 }, frameId: "F", serverId: "s1", dirty: false },
    { tempId: "a-F-2", classId: "cA", kind: "bbox", geometry: { kind: "bbox", x: 0, y: 0, w: 1, h: 1 }, frameId: "F", serverId: "s2", dirty: false },
    { tempId: "a-F-3", classId: "cA", kind: "bbox", geometry: { kind: "bbox", x: 0, y: 0, w: 1, h: 1 }, frameId: "F", serverId: "s3", dirty: false },
    { tempId: "a-G-1", classId: "cA", kind: "bbox", geometry: { kind: "bbox", x: 0, y: 0, w: 1, h: 1 }, frameId: "G", serverId: "s4", dirty: false },
    { tempId: "a-G-2", classId: "cA", kind: "bbox", geometry: { kind: "bbox", x: 0, y: 0, w: 1, h: 1 }, frameId: "G", serverId: "s5", dirty: false },
    { tempId: "b-F-1", classId: "cB", kind: "bbox", geometry: { kind: "bbox", x: 0, y: 0, w: 1, h: 1 }, frameId: "F", serverId: "s6", dirty: false },
  ]);
}

function openClassMenu(cid: string) {
  const trigger = screen.getByTestId(`class-menu-trigger-${cid}`);
  // Radix DropdownMenu opens via keyDown(Enter) reliably in jsdom (the
  // pointerDown+click path requires a real layout box that jsdom doesn't
  // produce for the floating content).
  trigger.focus();
  fireEvent.keyDown(trigger, { key: "Enter", code: "Enter" });
}

describe("ClassesPanel — per-class 3-dot menu (v3.0 B2)", () => {
  beforeEach(() => {
    useTool.getState().setActiveClassId(null);
    seed();
  });

  it("Clear on this frame removes only this-frame-this-class annotations", async () => {
    const onDeleteClass = vi.fn();
    render(
      <ConfirmProvider>
        <ClassesPanel
          classes={classes as any}
          currentFrameId="F"
          onDeleteClass={onDeleteClass}
        />
      </ConfirmProvider>,
    );

    openClassMenu("cA");
    const clearItem = await screen.findByTestId("class-menu-clear-frame-cA");
    fireEvent.click(clearItem);

    // ConfirmDialog appears — accept it.
    const confirmBtn = await screen.findByRole("button", { name: /^clear$/i });
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      const ids = Object.keys(useAnnotations.getState().byId).sort();
      // Only the three F+cA were removed.
      expect(ids).toEqual(["a-G-1", "a-G-2", "b-F-1"]);
    });
    // Class itself is untouched.
    expect(onDeleteClass).not.toHaveBeenCalled();
    // alpha row is still rendered.
    expect(screen.getByText("alpha")).toBeInTheDocument();
  });

  it("Cancelling the confirm leaves all annotations intact", async () => {
    render(
      <ConfirmProvider>
        <ClassesPanel
          classes={classes as any}
          currentFrameId="F"
          onDeleteClass={() => {}}
        />
      </ConfirmProvider>,
    );

    openClassMenu("cA");
    const clearItem = await screen.findByTestId("class-menu-clear-frame-cA");
    fireEvent.click(clearItem);

    const cancelBtn = await screen.findByRole("button", { name: /cancel/i });
    fireEvent.click(cancelBtn);

    // Nothing removed.
    const ids = Object.keys(useAnnotations.getState().byId).sort();
    expect(ids).toEqual(["a-F-1", "a-F-2", "a-F-3", "a-G-1", "a-G-2", "b-F-1"]);
  });

  it("Delete class… in the menu confirms then calls onDeleteClass", async () => {
    const onDeleteClass = vi.fn();
    render(
      <ConfirmProvider>
        <ClassesPanel
          classes={classes as any}
          currentFrameId="F"
          onDeleteClass={onDeleteClass}
        />
      </ConfirmProvider>,
    );

    openClassMenu("cB");
    const deleteItem = await screen.findByTestId("class-menu-delete-cB");
    fireEvent.click(deleteItem);

    const confirmBtn = await screen.findByRole("button", { name: /^delete$/i });
    fireEvent.click(confirmBtn);

    await waitFor(() => expect(onDeleteClass).toHaveBeenCalledWith("cB"));
  });

  it("Single-image asset (currentFrameId === null) clears only frameId-null rows", async () => {
    // Replace seed: 2 frame-null + 1 frame F.
    useAnnotations.getState().reset([
      { tempId: "n-1", classId: "cA", kind: "bbox", geometry: { kind: "bbox", x: 0, y: 0, w: 1, h: 1 }, frameId: null, serverId: "x1", dirty: false },
      { tempId: "n-2", classId: "cA", kind: "bbox", geometry: { kind: "bbox", x: 0, y: 0, w: 1, h: 1 }, frameId: null, serverId: "x2", dirty: false },
      { tempId: "f-1", classId: "cA", kind: "bbox", geometry: { kind: "bbox", x: 0, y: 0, w: 1, h: 1 }, frameId: "F", serverId: "x3", dirty: false },
    ]);
    render(
      <ConfirmProvider>
        <ClassesPanel
          classes={classes as any}
          currentFrameId={null}
          onDeleteClass={() => {}}
        />
      </ConfirmProvider>,
    );

    openClassMenu("cA");
    const clearItem = await screen.findByTestId("class-menu-clear-frame-cA");
    fireEvent.click(clearItem);
    const confirmBtn = await screen.findByRole("button", { name: /^clear$/i });
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      const ids = Object.keys(useAnnotations.getState().byId).sort();
      expect(ids).toEqual(["f-1"]);
    });
  });
});
