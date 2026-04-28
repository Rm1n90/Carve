import React from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/api/stats", () => ({
  statsApi: {
    projectStats: vi.fn(),
  },
}));

vi.mock("@/api/projects", () => ({
  projectsApi: {
    get: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock("@/api/tasks", () => ({
  tasksApi: {
    listForProject: vi.fn(),
    create: vi.fn(),
  },
}));

vi.mock("@/api/classes", () => ({
  classesApi: {
    listForProject: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    to: _to,
    params: _params,
    ...rest
  }: {
    children: React.ReactNode;
    to?: string;
    params?: Record<string, string>;
    [key: string]: unknown;
  }) => <a {...rest}>{children}</a>,
  useNavigate: () => vi.fn(),
}));

import { statsApi } from "@/api/stats";
import { projectsApi } from "@/api/projects";
import { tasksApi } from "@/api/tasks";
import { classesApi } from "@/api/classes";
import { ProjectDetailPage } from "@/pages/ProjectDetailPage";

function wrap(node: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{node}</QueryClientProvider>;
}

function setupMocks() {
  (projectsApi.get as any).mockResolvedValue({
    id: "p1",
    name: "Alpha",
    description: null,
    owner_id: "u",
    created_at: "2026-01-01",
  });
  (tasksApi.listForProject as any).mockResolvedValue([
    {
      id: "t1",
      project_id: "p1",
      name: "Test",
      kind: "image",
      created_at: "2026-01-01",
    },
  ]);
  (classesApi.listForProject as any).mockResolvedValue([
    {
      id: "c1",
      project_id: "p1",
      idx: 0,
      name: "car",
      color: "#ff0000",
      attributes: {},
      created_at: "2026-01-01",
    },
    {
      id: "c2",
      project_id: "p1",
      idx: 1,
      name: "truck",
      color: "#00ff00",
      attributes: {},
      created_at: "2026-01-01",
    },
    {
      id: "c3",
      project_id: "p1",
      idx: 2,
      name: "bike",
      color: "#0000ff",
      attributes: {},
      created_at: "2026-01-01",
    },
    {
      id: "c4",
      project_id: "p1",
      idx: 3,
      name: "bus",
      color: "#ffff00",
      attributes: {},
      created_at: "2026-01-01",
    },
  ]);
  (statsApi.projectStats as any).mockResolvedValue({
    totals: { annotations: 22, assets: 100, tasks: 1 },
    by_class: [
      { class_id: "c1", name: "car", count: 17 },
      { class_id: "c2", name: "truck", count: 2 },
      { class_id: "c3", name: "bike", count: 2 },
      { class_id: "c4", name: "bus", count: 1 },
    ],
    tasks: [{ task_id: "t1", name: "Test", progress_pct: 0.03 }],
  });
}

describe("ProjectDetailPage layout — v2.7 fix", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupMocks();
  });

  it("renders the overview two-column grid with items-start (no forced equal heights)", async () => {
    const { container } = render(wrap(<ProjectDetailPage projectId="p1" />));
    await waitFor(() => {
      expect(screen.getByTestId("project-detail-overview-grid")).toBeInTheDocument();
    });
    const grid = container.querySelector(
      "[data-testid='project-detail-overview-grid']",
    ) as HTMLElement;
    expect(grid).not.toBeNull();
    expect(grid.className).toMatch(/items-start/);
    expect(grid.className).toMatch(/grid/);
  });

  it("Tasks section outer container does NOT use min-h-* or h-full", async () => {
    const { container } = render(wrap(<ProjectDetailPage projectId="p1" />));
    await waitFor(() => {
      expect(screen.getByTestId("project-detail-tasks-section")).toBeInTheDocument();
    });
    const section = container.querySelector(
      "[data-testid='project-detail-tasks-section']",
    ) as HTMLElement;
    expect(section).not.toBeNull();
    expect(section.className).not.toMatch(/\bh-full\b/);
    expect(section.className).not.toMatch(/\bmin-h-/);
  });

  it("renders task rows with compact py-2 spacing (smaller than 96px)", async () => {
    const { container } = render(wrap(<ProjectDetailPage projectId="p1" />));
    await waitFor(() => {
      expect(screen.getByTestId("project-detail-tasks-section")).toBeInTheDocument();
    });
    const taskRow = container.querySelector(
      "[data-testid='project-detail-task-row-t1']",
    ) as HTMLElement;
    expect(taskRow).not.toBeNull();
    expect(taskRow.className).toMatch(/py-2(?!\.5|\d)/);
    expect(taskRow.className).not.toMatch(/py-3(\s|$)/);
  });

  it("'N total' indicator sits next to the Tasks heading (compact metadata)", async () => {
    render(wrap(<ProjectDetailPage projectId="p1" />));
    await waitFor(() => {
      expect(screen.getByTestId("project-detail-tasks-total")).toBeInTheDocument();
    });
    const total = screen.getByTestId("project-detail-tasks-total");
    expect(total.textContent).toMatch(/1/);
    expect(total.textContent).toMatch(/total/i);
  });

  it("Classes column still uses bounded shell (v2.6 work preserved)", async () => {
    const { container } = render(wrap(<ProjectDetailPage projectId="p1" />));
    await waitFor(() => {
      expect(screen.getByText("car")).toBeInTheDocument();
    });
    const shell = container.querySelector(
      "[data-testid='classes-editor-shell']",
    ) as HTMLElement;
    expect(shell).not.toBeNull();
    expect(shell.className).toMatch(/max-h-/);
  });
});
