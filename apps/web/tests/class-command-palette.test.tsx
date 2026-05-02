import React from "react";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { ClassCommandPalette } from "@/components/annotation/ClassCommandPalette";
import type { ClassRow } from "@/api/classes";
import { useTool } from "@/state/tool";
import { useAnnotations } from "@/state/annotations";
import { useClassRecents } from "@/state/classRecents";

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

// 70 classes — Car at idx 0, Cat at idx 1, then a long tail.
const NAMES = [
  "Car",
  "Cat",
  "Cab",
  "Carriage",
  "Caravan",
  "Camel",
  "Canyon",
  "Capybara",
  "Cardinal",
];
const TAIL_NAMES = Array.from({ length: 61 }, (_, i) => `Other-${i + 1}`);
const ALL_NAMES = [...NAMES, ...TAIL_NAMES]; // 70 total
const CLASSES: ClassRow[] = ALL_NAMES.map((n, i) => makeClass(i, n));

beforeEach(() => {
  useTool.getState().setActiveClassId(null);
  useAnnotations.getState().reset([]);
  useClassRecents.setState({ pinnedByProject: {}, recentByProject: {} });
});

afterEach(() => {
  cleanup();
});

function spyOpenChange() {
  const calls: boolean[] = [];
  return {
    fn: (next: boolean) => {
      calls.push(next);
    },
    calls,
  };
}

function renderPalette(
  override: Partial<React.ComponentProps<typeof ClassCommandPalette>> = {},
): { onOpenChange: ReturnType<typeof spyOpenChange> } {
  const onOpenChange = spyOpenChange();
  render(
    <ClassCommandPalette
      open
      onOpenChange={onOpenChange.fn}
      mode="set-active"
      projectId={PROJECT_ID}
      classes={CLASSES}
      {...override}
    />,
  );
  return { onOpenChange };
}

describe("ClassCommandPalette — set-active mode", () => {
  it("filters classes by query and lists Car first when typing 'ca'", () => {
    renderPalette();
    const input = screen.getByTestId(
      "class-command-palette-input",
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "ca" } });
    const items = screen.getAllByRole("option");
    expect(items[0].textContent).toMatch(/Car/);
  });

  it("Enter on highlighted item calls setActiveClassId", () => {
    const { onOpenChange } = renderPalette();
    const input = screen.getByTestId("class-command-palette-input");
    fireEvent.change(input, { target: { value: "ca" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(useTool.getState().activeClassId).toBe(CLASSES[0].id);
    expect(onOpenChange.calls).toContain(false);
  });

  it("Esc closes the palette", () => {
    const { onOpenChange } = renderPalette();
    const input = screen.getByTestId("class-command-palette-input");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onOpenChange.calls).toContain(false);
  });

  it("renders index hint '1' on the first class in the All tab", () => {
    renderPalette();
    expect(
      screen.getByTestId(`class-command-palette-hint-${CLASSES[0].id}`)
        .textContent,
    ).toBe("1");
  });

  it("pinning a class makes it appear in the Pinned tab", () => {
    renderPalette();
    const pinBtn = screen.getByTestId(
      `class-command-palette-pin-${CLASSES[1].id}`,
    );
    fireEvent.click(pinBtn);
    expect(
      useClassRecents.getState().isPinned(PROJECT_ID, CLASSES[1].id),
    ).toBe(true);
    const pinnedTab = screen.getByTestId("class-command-palette-tab-pinned");
    fireEvent.click(pinnedTab);
    expect(
      screen.getByTestId(`class-command-palette-item-${CLASSES[1].id}`),
    ).toBeInTheDocument();
  });
});

describe("ClassCommandPalette — reassign mode", () => {
  beforeEach(() => {
    useAnnotations.getState().reset([
      {
        tempId: "ann-1",
        classId: CLASSES[5].id,
        kind: "bbox",
        geometry: { kind: "bbox", x: 0, y: 0, w: 1, h: 1 },
        frameId: null,
        serverId: null,
        dirty: false,
      },
      {
        tempId: "ann-2",
        classId: CLASSES[5].id,
        kind: "bbox",
        geometry: { kind: "bbox", x: 0, y: 0, w: 1, h: 1 },
        frameId: null,
        serverId: null,
        dirty: false,
      },
    ]);
  });

  it("picking a class reassigns every selected annotation", () => {
    renderPalette({
      mode: "reassign",
      selectedAnnotationIds: ["ann-1", "ann-2"],
    });
    const input = screen.getByTestId("class-command-palette-input");
    fireEvent.change(input, { target: { value: "car" } });
    fireEvent.keyDown(input, { key: "Enter" });
    const byId = useAnnotations.getState().byId;
    expect(byId["ann-1"].classId).toBe(CLASSES[0].id);
    expect(byId["ann-2"].classId).toBe(CLASSES[0].id);
  });

  it("header copy reflects the selection size", () => {
    renderPalette({
      mode: "reassign",
      selectedAnnotationIds: ["ann-1", "ann-2"],
    });
    expect(
      screen.getByTestId("class-command-palette-header").textContent,
    ).toMatch(/Reassign 2 annotations/);
  });
});

describe("ClassCommandPalette — initialQuery seeds the search input (Task 5)", () => {
  it("opens with the initialQuery applied and the first match highlighted", () => {
    renderPalette({ initialQuery: "c" });
    const input = screen.getByTestId(
      "class-command-palette-input",
    ) as HTMLInputElement;
    expect(input.value).toBe("c");
    const items = screen.getAllByRole("option");
    expect(items[0].textContent).toMatch(/Car/);
  });
});
