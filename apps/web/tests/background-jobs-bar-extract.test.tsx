// Armin Mehri — mehri.armin@gmail.com
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/api/assets", () => ({
  assetsApi: {
    frameExtractStatus: vi.fn(),
  },
}));
vi.mock("@/api/sam", () => ({ samApi: { autoTextBatchProgress: vi.fn() } }));
vi.mock("@/api/phase2", () => ({ inferenceApi: { pollBatchProgress: vi.fn() } }));
vi.mock("@/api/yoloe", () => ({ yoloeApi: { pollBatch: vi.fn() } }));
vi.mock("@/lib/toast", () => ({ showToast: vi.fn() }));

import { assetsApi } from "@/api/assets";
import { useBackgroundJobs } from "@/state/backgroundJobs";
import { BackgroundJobsBar } from "@/components/BackgroundJobsBar";

function wrap(node: React.ReactNode) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  });
  return <QueryClientProvider client={qc}>{node}</QueryClientProvider>;
}

describe("BackgroundJobsBar — frame-extract polling", () => {
  beforeEach(() => {
    useBackgroundJobs.setState({ jobs: {}, expandRequest: null });
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("polls assetsApi.frameExtractStatus and pushes progress into the store", async () => {
    (assetsApi.frameExtractStatus as any).mockResolvedValue({
      status: "running",
      phase: "decoding",
      decoded: 50,
      expected: 100,
      uploaded: 0,
      message: null,
      job_id: "j-poll",
    });

    act(() => {
      useBackgroundJobs.getState().add({
        jobId: "j-poll",
        taskId: "t1",
        kind: "frame-extract",
        label: "Extracting frames",
        startedAt: Date.now(),
        assetId: "asset-X",
        cancel: async () => {},
      });
    });

    render(wrap(<BackgroundJobsBar />));

    await waitFor(
      () => {
        expect(assetsApi.frameExtractStatus).toHaveBeenCalledWith("asset-X");
      },
      { timeout: 2000 },
    );

    await waitFor(
      () => {
        const stored = useBackgroundJobs.getState().jobs["j-poll"];
        expect(stored.progress?.decoded).toBe(50);
        expect(stored.progress?.phase).toBe("decoding");
        expect(stored.progress?.status).toBe("running");
      },
      { timeout: 2000 },
    );
  });

  it("renders decoded/expected counter for frame-extract jobs", async () => {
    (assetsApi.frameExtractStatus as any).mockResolvedValue({
      status: "running",
      phase: "uploading",
      decoded: 80,
      expected: 100,
      uploaded: 60,
      message: null,
      job_id: "j-render",
    });

    act(() => {
      useBackgroundJobs.getState().add({
        jobId: "j-render",
        taskId: "t1",
        kind: "frame-extract",
        label: "Extracting clip.mp4",
        startedAt: Date.now(),
        assetId: "asset-Y",
        cancel: async () => {},
      });
    });

    const { container } = render(wrap(<BackgroundJobsBar />));

    await waitFor(
      () => {
        // Counter renders as decoded/expected
        expect(container.textContent).toMatch(/80\s*\/\s*100/);
      },
      { timeout: 2000 },
    );
  });
});
