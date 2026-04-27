import React from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/api/stats", () => ({
  statsApi: {
    classFrequency: vi.fn(),
    progress: vi.fn(),
    sizeDistribution: vi.fn(),
    aspectRatio: vi.fn(),
    heatmap: vi.fn(),
    timeOnTask: vi.fn(),
    density: vi.fn(),
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
import { StatsPanel } from "@/pages/StatsPanel";

function wrap(node: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{node}</QueryClientProvider>;
}

function defaultMocks() {
  (statsApi.classFrequency as any).mockResolvedValue([]);
  (statsApi.progress as any).mockResolvedValue({
    total_frames: 0,
    labeled_frames: 0,
    progress_pct: 0,
  });
  (statsApi.sizeDistribution as any).mockResolvedValue({ small: 0, medium: 0, large: 0 });
  (statsApi.aspectRatio as any).mockResolvedValue({
    "<0.33": 0,
    "0.33-0.67": 0,
    "0.67-1.5": 0,
    "1.5-3": 0,
    ">=3": 0,
  });
  (statsApi.heatmap as any).mockResolvedValue({ bins: 32, grid: Array(1024).fill(0) });
  (statsApi.timeOnTask as any).mockResolvedValue([]);
  (statsApi.density as any).mockResolvedValue([]);
}

describe("StatsPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    defaultMocks();
  });

  it("renders class frequency rows", async () => {
    (statsApi.classFrequency as any).mockResolvedValue([
      { class_id: "c1", class_idx: 0, class_name: "car", class_color: "#ff0000", count: 8 },
      { class_id: "c2", class_idx: 1, class_name: "truck", class_color: "#00ff00", count: 4 },
      { class_id: "c3", class_idx: 2, class_name: "bus", class_color: "#0000ff", count: 0 },
    ]);
    const { findByText } = render(wrap(<StatsPanel taskId="t1" />));
    await findByText(/car/);
    await findByText(/truck/);
    await findByText(/bus/);
  });

  it("renders task progress with total/labeled", async () => {
    (statsApi.progress as any).mockResolvedValue({
      total_frames: 12,
      labeled_frames: 5,
      progress_pct: 5 / 12,
    });
    const { findByText } = render(wrap(<StatsPanel taskId="t1" />));
    await findByText(/5\s*\/\s*12/);
  });

  it("renders size distribution legend", async () => {
    (statsApi.sizeDistribution as any).mockResolvedValue({ small: 2, medium: 3, large: 1 });
    const { findByText } = render(wrap(<StatsPanel taskId="t1" />));
    await findByText(/small/i);
    await findByText(/medium/i);
    await findByText(/large/i);
  });

  it("renders heatmap grid as 32x32 when data is non-empty", async () => {
    // grid with at least one non-zero value so the chart actually renders
    // (zero-everywhere now triggers the empty state instead).
    const grid = Array(1024).fill(0);
    grid[42] = 7;
    (statsApi.heatmap as any).mockResolvedValue({ bins: 32, grid });
    const { getAllByTestId } = render(wrap(<StatsPanel taskId="t1" />));
    await waitFor(() => {
      expect(getAllByTestId("heatmap-cell").length).toBe(1024);
    });
  });

  it("shows heatmap empty state when grid has no data", async () => {
    (statsApi.heatmap as any).mockResolvedValue({
      bins: 32,
      grid: Array(1024).fill(0),
    });
    const { findByTestId, queryAllByTestId } = render(
      wrap(<StatsPanel taskId="t1" />),
    );
    const card = await findByTestId("stats-card-heatmap");
    expect(card).toBeTruthy();
    // No cells rendered when empty
    await waitFor(() => {
      expect(queryAllByTestId("heatmap-cell").length).toBe(0);
    });
  });

  it("renders time-on-task list", async () => {
    (statsApi.timeOnTask as any).mockResolvedValue([
      { user_id: "u1", email: "alice@x", seconds: 90 },
      { user_id: "u2", email: "bob@x", seconds: 0 },
    ]);
    const { findByText } = render(wrap(<StatsPanel taskId="t1" />));
    await findByText(/alice@x/);
    await findByText(/bob@x/);
  });
});
