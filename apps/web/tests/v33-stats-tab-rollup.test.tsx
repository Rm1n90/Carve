import React from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// v3.3 Issue 1 — the Stats tab now renders a project rollup at the top
// (totals + by-class + per-task progress) AND a per-task selector so the
// user can switch which task's deep-dive widgets are shown. Default
// selection is `tasks[0]`. This test file locks in those behaviours.

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

vi.mock("@/api/tasks", () => ({
  tasksApi: {
    listForProject: vi.fn(),
  },
}));

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
import { tasksApi } from "@/api/tasks";
import { StatsPanel } from "@/pages/StatsPanel";

function wrap(node: React.ReactNode) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={qc}>{node}</QueryClientProvider>;
}

function emptyTaskStatsMocks() {
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

describe("v3.3 Issue 1 — Stats tab project rollup + task selector", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    emptyTaskStatsMocks();
    // Default project rollup payload: 42 annotations, 12 assets, and 3
    // tasks with varying progress. Tests can override per-test.
    (statsApi.projectStats as any).mockResolvedValue({
      totals: { annotations: 42, assets: 12, tasks: 3 },
      by_class: [{ class_id: "c1", name: "car", count: 30 }],
      tasks: [
        { task_id: "t1", name: "First", progress_pct: 0.5 },
        { task_id: "t2", name: "Second", progress_pct: 0.25 },
        { task_id: "t3", name: "Third", progress_pct: 0.0 },
      ],
    });
    (tasksApi.listForProject as any).mockResolvedValue([
      { id: "t1", project_id: "p1", name: "First", kind: "image", created_at: "2026-01-01" },
      { id: "t2", project_id: "p1", name: "Second", kind: "video", created_at: "2026-01-02" },
      { id: "t3", project_id: "p1", name: "Third", kind: "image", created_at: "2026-01-03" },
    ]);
  });

  it("renders the Project rollup section with totals from projectStats", async () => {
    const { findByTestId } = render(wrap(<StatsPanel projectId="p1" />));
    const rollup = await findByTestId("project-rollup");
    expect(rollup).toBeTruthy();
    // Annotations total
    const annTotal = await findByTestId("rollup-totals-annotations");
    expect(annTotal.textContent).toMatch(/42/);
    // Assets total
    const assetsTotal = await findByTestId("rollup-totals-assets");
    expect(assetsTotal.textContent).toMatch(/12/);
    // Completion is the average per-task progress as a %.
    // (0.5 + 0.25 + 0) / 3 = 0.25 → 25%.
    const completion = await findByTestId("rollup-totals-completion");
    expect(completion.textContent).toMatch(/25%/);
  });

  it("renders the by-class chip list spanning the whole project", async () => {
    const { findByTestId } = render(wrap(<StatsPanel projectId="p1" />));
    const byClass = await findByTestId("rollup-by-class");
    expect(byClass.textContent).toMatch(/car/);
    expect(byClass.textContent).toMatch(/30/);
  });

  it("renders a per-task progress bar for every task in the project", async () => {
    const { findByTestId } = render(wrap(<StatsPanel projectId="p1" />));
    await findByTestId("rollup-task-bar-t1");
    await findByTestId("rollup-task-bar-t2");
    await findByTestId("rollup-task-bar-t3");
  });

  it("shows the per-task selector trigger when there are 3 tasks", async () => {
    const { findByTestId } = render(wrap(<StatsPanel projectId="p1" />));
    const trigger = await findByTestId("per-task-selector");
    expect(trigger).toBeTruthy();
    // Radix Select renders Items lazily inside a portal — the trigger
    // shows the current value (the default first task name "First").
    expect(trigger.textContent).toMatch(/First/);
  });

  it("defaults the per-task selector to tasks[0] and queries its widgets", async () => {
    const { findByTestId } = render(wrap(<StatsPanel projectId="p1" />));
    // The deep-dive grid renders the six per-task widgets.
    await findByTestId("stats-grid");
    // tasks[0] is "t1" → progress() must have been called with "t1".
    await waitFor(() => {
      expect(
        (statsApi.progress as any).mock.calls.some(
          (c: unknown[]) => c[0] === "t1",
        ),
      ).toBe(true);
    });
  });

  it("does not render the selector when there is only one task", async () => {
    (tasksApi.listForProject as any).mockResolvedValue([
      { id: "t1", project_id: "p1", name: "Only", kind: "image", created_at: "2026-01-01" },
    ]);
    const { findByTestId, queryByTestId } = render(
      wrap(<StatsPanel projectId="p1" />),
    );
    // Header with task name still renders.
    await findByTestId("per-task-header");
    // No dropdown for a single-task project.
    expect(queryByTestId("per-task-selector")).toBeNull();
  });
});
