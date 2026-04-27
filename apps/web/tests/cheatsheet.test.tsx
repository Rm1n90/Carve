import React from "react";
import { describe, expect, it, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { KeyboardCheatSheet } from "@/components/annotation/KeyboardCheatSheet";

afterEach(() => {
  cleanup();
  document.body.removeAttribute("data-scroll-locked");
  document.body.removeAttribute("style");
});

describe("KeyboardCheatSheet (audit bug N — content matches real handlers)", () => {
  function open(): void {
    render(<KeyboardCheatSheet />);
    fireEvent.click(screen.getByTestId("cheatsheet-trigger"));
  }

  it("documents the shortcuts that ARE wired to handlers", () => {
    open();
    // Tools — present.
    expect(screen.getByText("Drag / select")).toBeInTheDocument();
    expect(screen.getByText("Bounding box")).toBeInTheDocument();
    expect(screen.getByText("Polygon")).toBeInTheDocument();
    expect(screen.getByText("Mask brush")).toBeInTheDocument();
    expect(screen.getByText("Smart (SAM)")).toBeInTheDocument();
    // Editing — Enter commits polygon (PolygonTool.onKeyDown).
    expect(screen.getByText("Commit polygon")).toBeInTheDocument();
    expect(screen.getByText(/cancel.*selection/i)).toBeInTheDocument();
    // Selection — class number keys are wired in ClassesPanel.
    expect(screen.getByText("Switch active class")).toBeInTheDocument();
    expect(screen.getByText("Multi-select")).toBeInTheDocument();
    expect(screen.getByText("Select all on frame")).toBeInTheDocument();
    // Navigation — ArrowLeft/Right wired in AnnotateAssetPage.
    expect(screen.getByText("Previous asset")).toBeInTheDocument();
    expect(screen.getByText("Next asset")).toBeInTheDocument();
    expect(screen.getByText("Fit to screen")).toBeInTheDocument();
    // Files — Cmd+S/Z/Shift+Z wired.
    expect(screen.getByText("Save now")).toBeInTheDocument();
    expect(screen.getByText("Undo")).toBeInTheDocument();
    expect(screen.getByText("Redo")).toBeInTheDocument();
    // Z-order — wired in AnnotateAssetPage.
    expect(screen.getByText("Bring to front")).toBeInTheDocument();
    expect(screen.getByText("Send to back")).toBeInTheDocument();
    expect(screen.getByText("Bring forward")).toBeInTheDocument();
    expect(screen.getByText("Send backward")).toBeInTheDocument();
  });

  it("does NOT document Space-pan (which has no handler)", () => {
    open();
    // The dialog body should not list a Space-pan shortcut. Audit bug N
    // called out that the prior cheat sheet documented "Space + drag"
    // even though nothing in the codebase wires a pan-via-space handler.
    const body = screen.getByRole("dialog");
    expect(body.textContent ?? "").not.toMatch(/space.*pan|pan.*space/i);
  });

  it("does NOT document a Track tool (R hotkey isn't wired)", () => {
    open();
    // The R hotkey for "Track" was previously listed even though only
    // V/B/P/M/T/S/A/F are registered as tool hotkeys in EditorToolbar.
    expect(screen.queryByText(/^Track$/)).toBeNull();
  });

  it("ends with a 'More shortcuts coming.' note", () => {
    open();
    expect(screen.getByText(/more shortcuts coming/i)).toBeInTheDocument();
  });
});
