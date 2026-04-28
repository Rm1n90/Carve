import React from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/api/classes", () => ({
  classesApi: {
    listForProject: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
}));

import { classesApi } from "@/api/classes";
import { ClassesEditor } from "@/pages/ClassesEditor";
import { ClassesPanel } from "@/components/annotation/ClassesPanel";

function wrap(node: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{node}</QueryClientProvider>;
}

function makeClasses(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `c-${i}`,
    project_id: "p1",
    idx: i,
    name: `class-${i}`,
    color: "#ff0000",
    attributes: {},
    created_at: "2026-01-01",
  }));
}

describe("ClassesEditor — bounded layout (project detail)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("outer container has bounded max-height to prevent unbounded growth", async () => {
    (classesApi.listForProject as any).mockResolvedValue(makeClasses(50));
    const { container } = render(wrap(<ClassesEditor projectId="p1" />));
    await waitFor(() => {
      expect(screen.getByText("class-0")).toBeInTheDocument();
    });
    const shell = container.querySelector(
      "[data-testid='classes-editor-shell']",
    ) as HTMLElement | null;
    expect(shell).not.toBeNull();
    expect(shell!.className).toMatch(/max-h-/);
  });

  it("scrollable list area exists with overflow-y-auto", async () => {
    (classesApi.listForProject as any).mockResolvedValue(makeClasses(50));
    const { container } = render(wrap(<ClassesEditor projectId="p1" />));
    await waitFor(() => {
      expect(screen.getByText("class-0")).toBeInTheDocument();
    });
    const list = container.querySelector(
      "[data-testid='classes-editor-list']",
    ) as HTMLElement | null;
    expect(list).not.toBeNull();
    expect(list!.className).toMatch(/overflow-y-auto/);
  });

  it("renders all 50 classes — uses internal scroll, not pagination", async () => {
    (classesApi.listForProject as any).mockResolvedValue(makeClasses(50));
    render(wrap(<ClassesEditor projectId="p1" />));
    await waitFor(() => {
      expect(screen.getByText("class-0")).toBeInTheDocument();
    });
    expect(screen.getByText("class-49")).toBeInTheDocument();
  });

  it("add-class form is the sticky footer of the bounded shell", async () => {
    (classesApi.listForProject as any).mockResolvedValue(makeClasses(2));
    const { container } = render(wrap(<ClassesEditor projectId="p1" />));
    await waitFor(() => {
      expect(screen.getByText("class-0")).toBeInTheDocument();
    });
    const footer = container.querySelector(
      "[data-testid='classes-editor-footer']",
    ) as HTMLElement | null;
    expect(footer).not.toBeNull();
    const shell = container.querySelector(
      "[data-testid='classes-editor-shell']",
    );
    expect(shell?.contains(footer!)).toBe(true);
  });
});

describe("ClassesPanel — bounded right-side editor panel", () => {
  it("the panel fills its parent without growing the page (h-full + flex-col)", () => {
    const fixture = makeClasses(60);
    const { container } = render(<ClassesPanel classes={fixture as any} />);
    const root = container.querySelector(
      "section[role='complementary']",
    ) as HTMLElement;
    expect(root).not.toBeNull();
    expect(root.className).toMatch(/h-full/);
    expect(root.className).toMatch(/flex-col/);
    const list = root.querySelector("ul.overflow-y-auto");
    expect(list).not.toBeNull();
  });
});
