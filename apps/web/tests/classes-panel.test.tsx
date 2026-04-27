import { describe, expect, it, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ClassesPanel } from "@/components/annotation/ClassesPanel";
import { useTool } from "@/state/tool";
import { useAnnotations } from "@/state/annotations";

const fixture = [
  { id: "c-1", project_id: "p", idx: 0, name: "car", color: "#ff0000", attributes: {}, created_at: "" },
  { id: "c-2", project_id: "p", idx: 1, name: "person", color: "#00ff00", attributes: {}, created_at: "" },
];

const triFixture = [
  { id: "c-1", project_id: "p", idx: 0, name: "alpha", color: "#ff0000", attributes: {}, created_at: "" },
  { id: "c-2", project_id: "p", idx: 1, name: "beta", color: "#00ff00", attributes: {}, created_at: "" },
  { id: "c-3", project_id: "p", idx: 2, name: "gamma", color: "#0000ff", attributes: {}, created_at: "" },
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

describe("ClassesPanel — search/sort/expand/hover", () => {
  beforeEach(() => {
    useTool.getState().setActiveClassId(null);
    useTool.getState().setHoveredAnnotationId(null);
    useAnnotations.getState().reset([]);
  });

  it("search input filters list as you type", () => {
    render(<ClassesPanel classes={triFixture as any} />);
    const input = screen.getByTestId("classes-search-input") as HTMLInputElement;
    expect(screen.getByText("alpha")).toBeInTheDocument();
    fireEvent.change(input, { target: { value: "gam" } });
    expect(screen.queryByText("alpha")).toBeNull();
    expect(screen.getByText("gamma")).toBeInTheDocument();
  });

  it("renders count badges from the annotation store", () => {
    useAnnotations.getState().reset([
      {
        tempId: "a-1", classId: "c-1", kind: "bbox",
        geometry: { kind: "bbox", x: 0, y: 0, w: 1, h: 1 },
        frameId: null, serverId: "s-a-1", dirty: false,
      },
      {
        tempId: "a-2", classId: "c-1", kind: "bbox",
        geometry: { kind: "bbox", x: 0, y: 0, w: 1, h: 1 },
        frameId: null, serverId: "s-a-2", dirty: false,
      },
    ]);
    render(<ClassesPanel classes={triFixture as any} />);
    const cnt = screen.getByTestId("class-count-c-1");
    expect(cnt.textContent).toBe("2");
  });

  it("expand chevron reveals per-class annotation rows", () => {
    useAnnotations.getState().reset([
      {
        tempId: "a-x", classId: "c-2", kind: "polygon",
        geometry: { kind: "polygon", points: [[0, 0], [1, 0], [1, 1]] },
        frameId: null, serverId: "s-a-x", dirty: false,
      },
    ]);
    render(<ClassesPanel classes={triFixture as any} />);
    expect(screen.queryByTestId("class-annotations-c-2")).toBeNull();
    fireEvent.click(screen.getByTestId("class-expand-c-2"));
    expect(screen.getByTestId("class-annotations-c-2")).toBeInTheDocument();
    expect(screen.getByTestId("annotation-row-a-x")).toBeInTheDocument();
  });

  it("hovering an annotation row updates hoveredAnnotationId in the store", () => {
    useAnnotations.getState().reset([
      {
        tempId: "a-y", classId: "c-3", kind: "bbox",
        geometry: { kind: "bbox", x: 0, y: 0, w: 1, h: 1 },
        frameId: null, serverId: "s-a-y", dirty: false,
      },
    ]);
    render(<ClassesPanel classes={triFixture as any} />);
    fireEvent.click(screen.getByTestId("class-expand-c-3"));
    fireEvent.mouseEnter(screen.getByTestId("annotation-row-a-y"));
    expect(useTool.getState().hoveredAnnotationId).toBe("a-y");
    fireEvent.mouseLeave(screen.getByTestId("annotation-row-a-y"));
    expect(useTool.getState().hoveredAnnotationId).toBeNull();
  });

  it("renders the sort trigger and default-ordered list", () => {
    render(<ClassesPanel classes={triFixture as any} />);
    expect(screen.getByTestId("classes-sort-trigger")).toBeInTheDocument();
    const items = screen.getAllByTestId(/^class-row-/);
    expect(items[0].getAttribute("data-testid")).toBe("class-row-c-1");
    expect(items[2].getAttribute("data-testid")).toBe("class-row-c-3");
  });

  it("clicking the sticky add button shows the inline add form when onCreateClass provided", () => {
    render(
      <ClassesPanel
        classes={triFixture as any}
        onCreateClass={() => {}}
      />,
    );
    fireEvent.click(screen.getByTestId("classes-add-button"));
    expect(screen.getByTestId("add-class-inline")).toBeInTheDocument();
  });
});
