/**
 * v3.0 B10 — Export dialog class density.
 *
 * With many classes the remap table must:
 *   - Render inside a max-height scroll container so the page doesn't grow
 *     unbounded.
 *   - Provide a search-by-name filter that narrows the visible rows.
 *   - Surface a "Showing N of M" count.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/api/exports", () => ({
  exportsApi: {
    create: vi.fn(),
    get: vi.fn(),
  },
}));

vi.mock("@/api/classes", () => ({
  classesApi: {
    listForProject: vi.fn(),
  },
}));

import { classesApi } from "@/api/classes";
import { ExportDialog } from "@/pages/ExportDialog";

afterEach(cleanup);

function manyClasses(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `c${i}`,
    project_id: "p1",
    idx: i,
    // Mix in a couple of recognisable names for the filter test.
    name: i === 7 ? "foobar" : i === 13 ? "foosball" : `class_${i}`,
    color: "#888",
    attributes: {},
    created_at: "",
  }));
}

function wrap(node: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{node}</QueryClientProvider>;
}

describe("ExportDialog — class density (v3.0 B10)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (classesApi.listForProject as any).mockResolvedValue(manyClasses(100));
  });

  it("renders the class-remap table inside a max-h-[400px] scroll container", async () => {
    const { findByTestId } = render(wrap(<ExportDialog projectId="p1" taskId="t1" />));
    const scrollHost = await findByTestId("export-class-table-scroll");
    expect(scrollHost.className).toMatch(/max-h-\[400px\]/);
    expect(scrollHost.className).toMatch(/overflow-y-auto/);
  });

  it("shows 'Showing N of M classes' count", async () => {
    const { findByTestId } = render(wrap(<ExportDialog projectId="p1" taskId="t1" />));
    const count = await findByTestId("export-class-count");
    expect(count.textContent).toMatch(/Showing\s+100\s+of\s+100\s+classes/);
  });

  it("filtering 'foo' narrows visible classes and updates the count", async () => {
    const { findByTestId, queryByText, getByText } = render(
      wrap(<ExportDialog projectId="p1" taskId="t1" />),
    );
    const input = (await findByTestId("export-class-filter")) as HTMLInputElement;
    // Sanity: an unrelated class is rendered before filter.
    await waitFor(() => expect(getByText("class_0")).toBeInTheDocument());

    fireEvent.change(input, { target: { value: "foo" } });

    await waitFor(() => {
      expect(queryByText("class_0")).toBeNull();
    });
    expect(getByText("foobar")).toBeInTheDocument();
    expect(getByText("foosball")).toBeInTheDocument();

    const count = await findByTestId("export-class-count");
    expect(count.textContent).toMatch(/Showing\s+2\s+of\s+100\s+classes/);
  });
});
