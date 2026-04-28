/**
 * Reproduction for v2.7 user-reported bug: "When I click add class the UI breaks".
 *
 * This file targets the editor's right-panel `AddClassInline` (rendered by
 * `ClassesPanel` when `onCreateClass` is provided). Wave 1 of v2.6 changed
 * this region to a sticky footer; we verify the click flow stays stable:
 *  - clicking "+ Add class" opens the inline form
 *  - typing a name and pressing Enter or clicking Add fires the callback
 *  - if the callback throws (mutation pre-flight error), the panel survives
 *  - Cancel returns the panel to its idle state
 */
import React from "react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { ClassesPanel } from "@/components/annotation/ClassesPanel";
import { useTool } from "@/state/tool";
import { useAnnotations } from "@/state/annotations";

const fixture = [
  {
    id: "c-1",
    project_id: "p",
    idx: 0,
    name: "alpha",
    color: "#ff0000",
    attributes: {},
    created_at: "",
  },
  {
    id: "c-2",
    project_id: "p",
    idx: 1,
    name: "beta",
    color: "#00ff00",
    attributes: {},
    created_at: "",
  },
];

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  useTool.getState().setActiveClassId(null);
  useTool.getState().setHoveredAnnotationId(null);
  useAnnotations.getState().reset([]);
});

describe("ClassesPanel — AddClassInline does not crash", () => {
  it("clicking '+ Add class' opens the inline form without crashing", () => {
    const onCreate = vi.fn();
    render(<ClassesPanel classes={fixture as any} onCreateClass={onCreate} />);
    fireEvent.click(screen.getByTestId("classes-add-button"));
    expect(screen.getByTestId("add-class-inline")).toBeInTheDocument();
    expect(screen.getByLabelText(/new class name/i)).toBeInTheDocument();
  });

  it("typing a name and pressing Enter calls onCreate and the panel survives", () => {
    const onCreate = vi.fn();
    render(<ClassesPanel classes={fixture as any} onCreateClass={onCreate} />);
    fireEvent.click(screen.getByTestId("classes-add-button"));

    const input = screen.getByLabelText(/new class name/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "test" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(onCreate.mock.calls[0][0]).toBe("test");
    expect(typeof onCreate.mock.calls[0][1]).toBe("string");
    expect(screen.getByTestId("classes-search-input")).toBeInTheDocument();
  });

  it("clicking the inline 'Add' button fires onCreate with name + color", () => {
    const onCreate = vi.fn();
    render(<ClassesPanel classes={fixture as any} onCreateClass={onCreate} />);
    fireEvent.click(screen.getByTestId("classes-add-button"));

    fireEvent.change(screen.getByLabelText(/new class name/i), {
      target: { value: "test" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^add$/i }));

    expect(onCreate).toHaveBeenCalledWith("test", expect.any(String));
    expect(screen.getByTestId("classes-search-input")).toBeInTheDocument();
  });

  it("does NOT crash when onCreate throws synchronously", () => {
    const onCreate = vi.fn(() => {
      throw new Error("network blew up");
    });
    render(<ClassesPanel classes={fixture as any} onCreateClass={onCreate} />);
    fireEvent.click(screen.getByTestId("classes-add-button"));

    fireEvent.change(screen.getByLabelText(/new class name/i), {
      target: { value: "test" },
    });

    // Click may rethrow into the test, but the panel must remain mounted.
    try {
      fireEvent.click(screen.getByRole("button", { name: /^add$/i }));
    } catch {
      /* swallow — we only care that the panel survived. */
    }
    expect(screen.queryByTestId("classes-search-input")).toBeInTheDocument();
  });

  it("Cancel closes the inline form and the panel returns to its idle state", () => {
    const onCreate = vi.fn();
    render(<ClassesPanel classes={fixture as any} onCreateClass={onCreate} />);
    fireEvent.click(screen.getByTestId("classes-add-button"));
    expect(screen.getByTestId("add-class-inline")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(screen.queryByTestId("add-class-inline")).toBeNull();
    expect(screen.getByTestId("classes-add-button")).toBeInTheDocument();
  });
});
