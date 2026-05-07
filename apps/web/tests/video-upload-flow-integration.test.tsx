// Armin Mehri — mehri.armin@gmail.com
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/api/assets", () => ({
  assetsApi: {
    upload: vi.fn(),
    uploadZip: vi.fn(),
    reextractFrames: vi.fn(),
    frameExtractStatus: vi.fn(),
  },
}));
vi.mock("@/api/sam", () => ({ samApi: { autoTextBatchProgress: vi.fn() } }));
vi.mock("@/api/phase2", () => ({ inferenceApi: { pollBatchProgress: vi.fn() } }));
vi.mock("@/api/yoloe", () => ({ yoloeApi: { pollBatch: vi.fn() } }));
vi.mock("@/lib/toast", () => ({ showToast: vi.fn() }));

import { assetsApi } from "@/api/assets";
import { useBackgroundJobs } from "@/state/backgroundJobs";
import { AssetUploadDialog } from "@/pages/AssetUploadDialog";
import { BackgroundJobsBar } from "@/components/BackgroundJobsBar";

function wrap(node: React.ReactNode) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  });
  return <QueryClientProvider client={qc}>{node}</QueryClientProvider>;
}

describe("video upload + extract integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useBackgroundJobs.setState({ jobs: {}, expandRequest: null });
  });

  it("drops video → picks strategy → uploads → bar registers job → status flows through", async () => {
    (assetsApi.upload as any).mockResolvedValue({
      id: "v-1",
      kind: "video",
      extract_required: true,
    });
    (assetsApi.reextractFrames as any).mockResolvedValue({
      job_id: "j-1",
      strategy: "count",
      n: 500,
    });
    let pollCount = 0;
    (assetsApi.frameExtractStatus as any).mockImplementation(async () => {
      pollCount += 1;
      if (pollCount >= 3) {
        return {
          status: "completed",
          phase: "done",
          decoded: 500,
          expected: 500,
          uploaded: 500,
          message: null,
          job_id: "j-1",
        };
      }
      return {
        status: "running",
        phase: "decoding",
        decoded: pollCount * 100,
        expected: 500,
        uploaded: 0,
        message: null,
        job_id: "j-1",
      };
    });

    const { container } = render(
      wrap(
        <>
          <AssetUploadDialog projectId="p" taskId="t1" />
          <BackgroundJobsBar />
        </>,
      ),
    );

    // Phase A → Phase B: drop a video.
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, {
      target: {
        files: [
          new File([new Uint8Array(8)], "clip.mp4", { type: "video/mp4" }),
        ],
      },
    });

    await waitFor(() =>
      expect(screen.getByTestId("frame-extract-strategy-count"))
        .toBeInTheDocument(),
    );

    // Phase B → Phase C: confirm strategy.
    fireEvent.click(screen.getByTestId("upload-continue"));

    await waitFor(() => expect(assetsApi.reextractFrames).toHaveBeenCalled());

    // Job registered with assetId.
    await waitFor(() => {
      const j = Object.values(useBackgroundJobs.getState().jobs)
        .find((x) => x.kind === "frame-extract");
      expect(j?.assetId).toBe("v-1");
      expect(j?.jobId).toBe("j-1");
    });

    // Bar polls and pushes progress to the store.
    await waitFor(
      () => {
        const j = Object.values(useBackgroundJobs.getState().jobs)
          .find((x) => x.kind === "frame-extract");
        expect(j?.progress?.decoded).toBeGreaterThan(0);
      },
      { timeout: 3000 },
    );

    // Eventually reaches completed status (or has been removed).
    await waitFor(
      () => {
        const j = Object.values(useBackgroundJobs.getState().jobs)
          .find((x) => x.kind === "frame-extract");
        expect(j === undefined || j.progress?.status === "completed").toBe(true);
      },
      { timeout: 5000 },
    );
  });
});
