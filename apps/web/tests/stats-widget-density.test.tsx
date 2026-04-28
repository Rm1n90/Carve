import React from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
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

function emptyMocks() {
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

describe("StatsPanel — widget density", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    emptyMocks();
  });

  it("renders all 6 widget cards in the grid even with empty data", async () => {
    render(wrap(<StatsPanel taskId="t1" />));
    await waitFor(() => {
      expect(screen.getByTestId("stats-card-class-frequency")).toBeInTheDocument();
    });
    expect(screen.getByTestId("stats-card-progress")).toBeInTheDocument();
    expect(screen.getByTestId("stats-card-size-distribution")).toBeInTheDocument();
    expect(screen.getByTestId("stats-card-heatmap")).toBeInTheDocument();
    expect(screen.getByTestId("stats-card-aspect-ratio")).toBeInTheDocument();
    expect(screen.getByTestId("stats-card-time-on-task")).toBeInTheDocument();
  });

  it("widget cards use compact padding (p-3, not p-4 or p-5)", async () => {
    render(wrap(<StatsPanel taskId="t1" />));
    const card = await screen.findByTestId("stats-card-class-frequency");
    expect(card.className).not.toMatch(/(?:^|\s)p-5(?:\s|$)/);
    expect(card.className).not.toMatch(/(?:^|\s)p-4(?:\s|$)/);
    expect(card.className).toMatch(/(?:^|\s)p-3(?:\s|$)/);
  });

  it("widget grid uses tighter gap (gap-3, not gap-4)", async () => {
    render(wrap(<StatsPanel taskId="t1" />));
    const grid = await screen.findByTestId("stats-grid");
    expect(grid.className).not.toMatch(/(?:^|\s)gap-4(?:\s|$)/);
    expect(grid.className).toMatch(/(?:^|\s)gap-3(?:\s|$)/);
  });

  it("empty states use compact icon + 1-line message (no chunky py-6 padding)", async () => {
    render(wrap(<StatsPanel taskId="t1" />));
    await waitFor(() => {
      expect(screen.getAllByTestId("stats-empty-state").length).toBeGreaterThan(0);
    });
    const states = screen.getAllByTestId("stats-empty-state");
    for (const s of states) {
      expect(s.className).not.toMatch(/(?:^|\s)py-6(?:\s|$)/);
    }
  });

  it("cards still maintain a minimum bound so the grid doesn't collapse", async () => {
    render(wrap(<StatsPanel taskId="t1" />));
    const card = await screen.findByTestId("stats-card-progress");
    expect(card.className).toMatch(/min-h-/);
  });
});
