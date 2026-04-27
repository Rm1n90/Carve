import React from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// ---- Mocks for all API surfaces touched by Stats route + project detail tabs.

vi.mock("@/api/stats", () => ({
  statsApi: {
    classFrequency: vi.fn(),
    progress: vi.fn(),
    sizeDistribution: vi.fn(),
    aspectRatio: vi.fn(),
    heatmap: vi.fn(),
    timeOnTask: vi.fn(),
    density: vi.fn(),
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
  // Forward attributes (e.g. data-testid, className) so tests can assert on them.
  Link: ({
    children,
    to,
    params: _params,
    ...rest
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & {
    to?: string;
    params?: Record<string, unknown>;
  }) => (
    <a href={typeof to === "string" ? to : "#"} {...rest}>
      {children}
    </a>
  ),
  useNavigate: () => vi.fn(),
}));

// recharts ResponsiveContainer needs a size, jsdom doesn't compute layout.
vi.mock("recharts", async () => {
  const actual = await vi.importActual<typeof import("recharts")>("recharts");
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: React.ReactNode }) => (
      <div style={{ width: 400, height: 300 }}>{children}</div>
    ),
  };
});

import { statsApi } from "@/api/stats";
import { projectsApi } from "@/api/projects";
import { tasksApi } from "@/api/tasks";
import { classesApi } from "@/api/classes";
import { StatsPanel } from "@/pages/StatsPanel";
import { ProjectDetailPage } from "@/pages/ProjectDetailPage";

function wrap(node: React.ReactNode) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={qc}>{node}</QueryClientProvider>;
}

// Radix Tabs.Trigger needs a full pointer event sequence under jsdom.
// fireEvent.click alone doesn't switch tabs.
function clickTab(el: Element) {
  fireEvent.pointerDown(el);
  fireEvent.mouseDown(el);
  fireEvent.click(el);
}

function emptyTaskStats() {
  (statsApi.classFrequency as any).mockResolvedValue([]);
  (statsApi.progress as any).mockResolvedValue({
    total_frames: 0,
    labeled_frames: 0,
    progress_pct: 0,
  });
  (statsApi.sizeDistribution as any).mockResolvedValue({
    small: 0,
    medium: 0,
    large: 0,
  });
  (statsApi.aspectRatio as any).mockResolvedValue({
    "<0.33": 0,
    "0.33-0.67": 0,
    "0.67-1.5": 0,
    "1.5-3": 0,
    ">=3": 0,
  });
  (statsApi.heatmap as any).mockResolvedValue({
    bins: 32,
    grid: Array(1024).fill(0),
  });
  (statsApi.timeOnTask as any).mockResolvedValue([]);
  (statsApi.density as any).mockResolvedValue([]);
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
  (statsApi.projectStats as any).mockResolvedValue({
    totals: { annotations: 0, assets: 0, tasks: 0 },
    by_class: [],
    tasks: [],
  });
}

describe("StatsPanel project mode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    emptyTaskStats();
  });

  it("renders 'no tasks' empty state when project has zero tasks", async () => {
    (tasksApi.listForProject as any).mockResolvedValue([]);
    const { findByTestId } = render(wrap(<StatsPanel projectId="p1" />));
    await findByTestId("stats-no-tasks");
  });

  it("renders the 6-widget grid for the project's first task", async () => {
    (tasksApi.listForProject as any).mockResolvedValue([
      { id: "t1", project_id: "p1", name: "First", kind: "image", created_at: "2026-01-01" },
    ]);
    const { findByTestId } = render(wrap(<StatsPanel projectId="p1" />));
    await findByTestId("stats-grid");
    await findByTestId("stats-card-class-frequency");
    await findByTestId("stats-card-progress");
    await findByTestId("stats-card-size-distribution");
    await findByTestId("stats-card-heatmap");
    await findByTestId("stats-card-aspect-ratio");
    await findByTestId("stats-card-time-on-task");
  });

  it("shows a hint when there are multiple tasks", async () => {
    (tasksApi.listForProject as any).mockResolvedValue([
      { id: "t1", project_id: "p1", name: "First", kind: "image", created_at: "2026-01-01" },
      { id: "t2", project_id: "p1", name: "Second", kind: "video", created_at: "2026-01-02" },
    ]);
    const { findByText } = render(wrap(<StatsPanel projectId="p1" />));
    await findByText(/2 tasks total/);
  });

  it("renders empty states (not broken charts) when task stats are zero", async () => {
    (tasksApi.listForProject as any).mockResolvedValue([
      { id: "t1", project_id: "p1", name: "First", kind: "image", created_at: "2026-01-01" },
    ]);
    const { queryAllByTestId, findByTestId } = render(
      wrap(<StatsPanel projectId="p1" />),
    );
    await findByTestId("stats-grid");
    // All six widgets share the same `stats-empty-state` test id once their
    // queries resolve. Wait until they all render.
    await waitFor(() => {
      expect(queryAllByTestId("stats-empty-state").length).toBeGreaterThanOrEqual(6);
    });
  });
});

describe("ProjectDetailPage tabs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    defaultProjectMocks();
    emptyTaskStats();
  });

  it("renders the three tabs", async () => {
    const { findByTestId } = render(
      wrap(<ProjectDetailPage projectId="p1" />),
    );
    await findByTestId("project-tab-overview");
    await findByTestId("project-tab-stats");
    await findByTestId("project-tab-settings");
  });

  it("shows Overview content by default (tasks list)", async () => {
    const { findByText } = render(
      wrap(<ProjectDetailPage projectId="p1" />),
    );
    await findByText(/Tasks/);
  });

  it("renders StatsPanel inline when the Stats tab is clicked", async () => {
    (tasksApi.listForProject as any).mockResolvedValue([
      { id: "t1", project_id: "p1", name: "First", kind: "image", created_at: "2026-01-01" },
    ]);
    const { findByTestId } = render(
      wrap(<ProjectDetailPage projectId="p1" />),
    );
    clickTab(await findByTestId("project-tab-stats"));
    await findByTestId("stats-panel-project");
    await findByTestId("stats-grid");
  });

  it("shows the Settings form when Settings tab is clicked", async () => {
    const { findByTestId } = render(
      wrap(<ProjectDetailPage projectId="p1" />),
    );
    clickTab(await findByTestId("project-tab-settings"));
    await findByTestId("project-settings-form");
  });

  it("removes the legacy hidden by_class placeholder", async () => {
    // Even with by_class data, the strip should not render an empty hidden
    // placeholder anymore — it should render a real chip list, not <span hidden>.
    (statsApi.projectStats as any).mockResolvedValue({
      totals: { annotations: 5, assets: 0, tasks: 0 },
      by_class: [{ class_id: "c1", name: "car", count: 5 }],
      tasks: [],
    });
    const { findByTestId } = render(
      wrap(<ProjectDetailPage projectId="p1" />),
    );
    const byClass = await findByTestId("project-stats-by-class");
    expect(byClass.hasAttribute("hidden")).toBe(false);
    expect(byClass.getAttribute("aria-hidden")).not.toBe("true");
  });

  it("links to /projects/:id/stats from the header", async () => {
    const { findByTestId } = render(
      wrap(<ProjectDetailPage projectId="p1" />),
    );
    const link = await findByTestId("project-detail-view-stats-link");
    expect(link.textContent).toMatch(/View stats/i);
  });
});
