import { describe, expect, it, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ClassesPanel } from "@/components/annotation/ClassesPanel";
import { useTool } from "@/state/tool";

const fixture = [
  { id: "c-1", project_id: "p", idx: 0, name: "car", color: "#ff0000", attributes: {}, created_at: "" },
  { id: "c-2", project_id: "p", idx: 1, name: "person", color: "#00ff00", attributes: {}, created_at: "" },
];

describe("ClassesPanel", () => {
  beforeEach(() => useTool.getState().setActiveClassId(null));

  it("clicking a class sets it active", () => {
    render(<ClassesPanel classes={fixture as any} />);
    fireEvent.click(screen.getByText("car"));
    expect(useTool.getState().activeClassId).toBe("c-1");
  });

  it("hotkey '2' selects the second class", () => {
    render(<ClassesPanel classes={fixture as any} />);
    fireEvent.keyDown(window, { key: "2" });
    expect(useTool.getState().activeClassId).toBe("c-2");
  });
});
