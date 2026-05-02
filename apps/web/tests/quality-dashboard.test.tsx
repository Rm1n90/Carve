/**
 * Plan-13 Phase 7 Task 11 — quality dashboard render + range refetch tests.
 */
import React from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/api/quality", () => ({
  qualityApi: {
    reviewerQuality: vi.fn(),
    perClassQuality: vi.fn(),
    retrainHistory: vi.fn(),
  },
}));

vi.mock("@/api/tasks", () => ({
  tasksApi: {
    listForProject: vi.fn().mockResolvedValue([{ id: "task-1", name: "T" }]),
  },
}));

import { qualityApi } from "@/api/quality";
import { QualityDashboard } from "@/components/stats/QualityDashboard";

function wrap(node: React.ReactNode) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={qc}>{node}</QueryClientProvider>;
}

beforeEach(() => {
  vi.clearAllMocks();
  (qualityApi.reviewerQuality as any).mockResolvedValue([
    {
      reviewer_id: "u1",
      email: "alice@x.com",
      total_reviewed: 20,
      accepted: 18,
      rejected: 2,
      accept_rate: 0.9,
    },
  ]);
  (qualityApi.perClassQuality as any).mockResolvedValue([
    {
      class_id: "c1",
      name: "car",
      color: "#ff0000",
      proposed: 5,
      accepted: 8,
      rejected: 2,
      proxy_precision: 0.8,
    },
  ]);
  (qualityApi.retrainHistory as any).mockResolvedValue([
    {
      weight_id: "w1",
      created_at: "2026-04-01T00:00:00Z",
      metrics: { mAP50: 0.7, "mAP50-95": 0.5 },
      epochs: 30,
      imgsz: 640,
    },
    {
      weight_id: "w2",
      created_at: "2026-04-15T00:00:00Z",
      metrics: { mAP50: 0.81, "mAP50-95": 0.62 },
      epochs: 30,
      imgsz: 640,
    },
  ]);
});

describe("QualityDashboard", () => {
  it("renders all three sections with mocked data", async () => {
    const { findByTestId } = render(
      wrap(<QualityDashboard projectId="p1" />),
    );
    await findByTestId("quality-reviewer-card");
    await findByTestId("quality-per-class-card");
    await findByTestId("quality-retrain-card");
    await findByTestId("quality-reviewer-row-u1");
    await waitFor(() => {
      expect(qualityApi.reviewerQuality).toHaveBeenCalled();
      expect(qualityApi.retrainHistory).toHaveBeenCalled();
    });
  });

  it("refetches reviewer quality when the time range changes", async () => {
    const { findByTestId } = render(
      wrap(<QualityDashboard projectId="p1" />),
    );
    await findByTestId("quality-reviewer-card");

    await waitFor(() => {
      expect(qualityApi.reviewerQuality).toHaveBeenCalledTimes(1);
    });

    fireEvent.click(await findByTestId("quality-range-7d"));
    await waitFor(() => {
      expect(qualityApi.reviewerQuality).toHaveBeenCalledTimes(2);
    });

    fireEvent.click(await findByTestId("quality-range-90d"));
    await waitFor(() => {
      expect(qualityApi.reviewerQuality).toHaveBeenCalledTimes(3);
    });
  });
});
