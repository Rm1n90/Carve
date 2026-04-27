import React from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/api/stats", () => ({
  statsApi: {
    projectStats: vi.fn(),
  },
}));

vi.mock("@/api/projects", () => ({
  projectsApi: {
    get: vi.fn(),
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
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
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

function defaultProjectMocks() {
  (projectsApi.get as any).mockResolvedValue({
    id: "p1",
    name: "Alpha",
    description: null,
    owner_id: "u",
    created_at: "2026-01-01",
  });
  (tasksApi.listForProject as any).mockResolvedValue([]);
  (classesApi.listForProject as any).mockResolvedValue([]);
}

describe("ProjectDetailPage stats strip", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    defaultProjectMocks();
  });

  it("renders totals tiles", async () => {
    (statsApi.projectStats as any).mockResolvedValue({
      totals: { annotations: 12, assets: 5, tasks: 2 },
      by_class: [],
      tasks: [],
    });
    const { findByTestId } = render(wrap(<ProjectDetailPage projectId="p1" />));
    const annotations = await findByTestId("project-stats-totals-annotations");
    const assets = await findByTestId("project-stats-totals-assets");
    const tasks = await findByTestId("project-stats-totals-tasks");
    expect(annotations.textContent).toMatch(/12/);
    expect(annotations.textContent).toMatch(/Annotations/i);
    expect(assets.textContent).toMatch(/5/);
    expect(assets.textContent).toMatch(/Assets/i);
    expect(tasks.textContent).toMatch(/2/);
    expect(tasks.textContent).toMatch(/Tasks/i);
  });

  it("renders top class chips", async () => {
    (statsApi.projectStats as any).mockResolvedValue({
      totals: { annotations: 11, assets: 0, tasks: 0 },
      by_class: [
        { class_id: "c1", name: "car", count: 8 },
        { class_id: "c2", name: "truck", count: 3 },
      ],
      tasks: [],
    });
    const { findByText } = render(wrap(<ProjectDetailPage projectId="p1" />));
    await findByText(/car/);
    await findByText(/truck/);
  });

  it("renders per-task progress bars", async () => {
    (statsApi.projectStats as any).mockResolvedValue({
      totals: { annotations: 4, assets: 1, tasks: 1 },
      by_class: [],
      tasks: [{ task_id: "t1", name: "T1", progress_pct: 0.42 }],
    });
    const { findByText, findByTestId } = render(
      wrap(<ProjectDetailPage projectId="p1" />),
    );
    await findByText(/T1/);
    const bar = await findByTestId("project-stats-task-bar-t1");
    await waitFor(() => {
      expect(bar.style.width).toBe("42%");
    });
  });
});
