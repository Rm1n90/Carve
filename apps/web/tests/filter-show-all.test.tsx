// Armin Mehri — mehri.armin@gmail.com
//
// "Show all annotations on the matching images": the filter still picks
// the images the arrow keys stop on, but every annotation on them stays
// in view.
import React, { useState } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ObjectsPanel } from "@/components/annotation/ObjectsPanel";
import { FilterBuilderDialog } from "@/components/annotation/FilterBuilderDialog";
import { ConfirmProvider } from "@/components/ui/ConfirmDialog";
import { useAnnotations } from "@/state/annotations";
import { useFilter } from "@/state/annotationFilter";
import type { ClassRow } from "@/api/classes";
import type { FilterGroup } from "@/lib/annotation-filter";

const FRAME = "frame-1";
const BACKDROP_ONLY: FilterGroup = {
  combinator: "AND",
  rules: [{ not: false, field: "label", op: "==", value: "backdrop" }],
};

function cls(id: string, idx: number, name: string): ClassRow {
  return { id, project_id: "p", idx, name, color: "#ff0000", attributes: {}, created_at: "2026-01-01T00:00:00Z" } as ClassRow;
}

const CLASSES: Record<string, ClassRow> = {
  "c-backdrop": cls("c-backdrop", 0, "backdrop"),
  "c-person": cls("c-person", 1, "person"),
};

function box(tempId: string, classId: string) {
  return {
    tempId,
    classId,
    kind: "bbox" as const,
    geometry: { kind: "bbox" as const, x: 0, y: 0, w: 5, h: 5 },
    frameId: FRAME,
    serverId: null,
    dirty: false,
  };
}

function wrap(node: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <ConfirmProvider>{node}</ConfirmProvider>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  window.localStorage.clear();
  useFilter.setState({ filter: null, showAll: false });
  useAnnotations.getState().reset([]);
  useAnnotations.getState().add(box("a-backdrop", "c-backdrop"));
  useAnnotations.getState().add(box("a-person", "c-person"));
  useAnnotations.getState().add(box("a-person-2", "c-person"));
});

afterEach(() => {
  cleanup();
  document.body.removeAttribute("data-scroll-locked");
  document.body.removeAttribute("style");
});

describe("Objects panel", () => {
  it("shows only the matches by default", () => {
    useFilter.getState().setFilter(BACKDROP_ONLY);
    render(wrap(<ObjectsPanel frameId={FRAME} classes={CLASSES} />));
    expect(screen.getByTestId("filter-active-pill").textContent).toContain("1 of 3 shown");
    expect(screen.getByTestId("object-row-a-backdrop")).toBeTruthy();
    expect(screen.queryByTestId("object-row-a-person")).toBeNull();
  });

  it("shows every annotation once 'Show all' is on, and back", () => {
    useFilter.getState().setFilter(BACKDROP_ONLY);
    render(wrap(<ObjectsPanel frameId={FRAME} classes={CLASSES} />));

    fireEvent.click(screen.getByTestId("filter-active-show-all"));
    expect(useFilter.getState().showAll).toBe(true);
    expect(screen.getByTestId("filter-active-pill").textContent).toContain("1 of 3 match, all shown");
    expect(screen.getByTestId("object-row-a-person")).toBeTruthy();
    expect(screen.getByTestId("object-row-a-person-2")).toBeTruthy();
    // The filter itself stays on: it still drives the arrow keys.
    expect(useFilter.getState().filter).toEqual(BACKDROP_ONLY);

    fireEvent.click(screen.getByTestId("filter-active-show-all"));
    expect(screen.queryByTestId("object-row-a-person")).toBeNull();
  });
});

describe("Filter dialog", () => {
  function Harness() {
    const [open, setOpen] = useState(true);
    return <FilterBuilderDialog open={open} onOpenChange={setOpen} />;
  }

  it("applies the option on Submit", () => {
    useFilter.getState().setFilter(BACKDROP_ONLY);
    render(<Harness />);
    fireEvent.click(screen.getByTestId("filter-show-all"));
    expect(useFilter.getState().showAll).toBe(false);
    fireEvent.click(screen.getByTestId("filter-submit"));
    expect(useFilter.getState().showAll).toBe(true);
    expect(useFilter.getState().filter).toEqual(BACKDROP_ONLY);
  });

  it("leaves it as it was on Cancel", () => {
    useFilter.getState().setFilter(BACKDROP_ONLY);
    render(<Harness />);
    fireEvent.click(screen.getByTestId("filter-show-all"));
    fireEvent.click(screen.getByTestId("filter-cancel"));
    expect(useFilter.getState().showAll).toBe(false);
  });
});

describe("the choice is remembered in this browser", () => {
  it("is written to local storage", () => {
    useFilter.getState().setShowAll(true);
    expect(window.localStorage.getItem("carve:filter-show-all")).toBe("1");
    useFilter.getState().setShowAll(false);
    expect(window.localStorage.getItem("carve:filter-show-all")).toBe("0");
  });
});
