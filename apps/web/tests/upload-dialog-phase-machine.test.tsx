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
  },
}));
vi.mock("@/lib/toast", () => ({ showToast: vi.fn() }));

import { assetsApi } from "@/api/assets";
import { useBackgroundJobs } from "@/state/backgroundJobs";
import { AssetUploadDialog } from "@/pages/AssetUploadDialog";

function wrap(node: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{node}</QueryClientProvider>;
}

function pickFiles(container: HTMLElement, files: File[]) {
  const input = container.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(input, { target: { files } });
}

describe("AssetUploadDialog phase machine", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useBackgroundJobs.setState({ jobs: {}, expandRequest: null });
  });

  it("skips videoSetup when no videos are dropped", async () => {
    (assetsApi.upload as any).mockResolvedValue({
      id: "a1", kind: "image", extract_required: false,
    });
    const { container } = render(
      wrap(<AssetUploadDialog projectId="p" taskId="t1" />),
    );
    pickFiles(container, [
      new File([new Uint8Array([0x89, 0x50])], "x.png", { type: "image/png" }),
    ]);
    await waitFor(() => expect(assetsApi.upload).toHaveBeenCalled());
    expect(screen.queryByTestId("frame-extract-strategy-count")).toBeNull();
    expect(assetsApi.reextractFrames).not.toHaveBeenCalled();
  });

  it("goes pick → videoSetup → uploading and registers a frame-extract job", async () => {
    (assetsApi.upload as any).mockResolvedValue({
      id: "v1", kind: "video", extract_required: true,
    });
    (assetsApi.reextractFrames as any).mockResolvedValue({
      job_id: "j-extract-1", strategy: "count", n: 500,
    });

    const { container } = render(
      wrap(<AssetUploadDialog projectId="p" taskId="t1" />),
    );

    pickFiles(container, [
      new File([new Uint8Array(8)], "clip.mp4", { type: "video/mp4" }),
    ]);

    await waitFor(() =>
      expect(screen.getByTestId("frame-extract-strategy-count"))
        .toBeInTheDocument(),
    );
    expect(assetsApi.upload).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("upload-continue"));

    await waitFor(() => expect(assetsApi.upload).toHaveBeenCalled());
    await waitFor(() =>
      expect(assetsApi.reextractFrames).toHaveBeenCalledWith("v1", {
        strategy: "count",
        n: 500,
        quality: 75,
      }),
    );

    await waitFor(() => {
      const jobs = Object.values(useBackgroundJobs.getState().jobs);
      const j = jobs.find((x) => x.kind === "frame-extract");
      expect(j?.jobId).toBe("j-extract-1");
      expect(j?.assetId).toBe("v1");
      expect(j?.taskId).toBe("t1");
    });
  });

  it("Cancel from videoSetup returns to pick and clears files", async () => {
    const { container } = render(
      wrap(<AssetUploadDialog projectId="p" taskId="t1" />),
    );
    pickFiles(container, [
      new File([new Uint8Array(8)], "clip.mp4", { type: "video/mp4" }),
    ]);
    await waitFor(() =>
      expect(screen.getByTestId("frame-extract-strategy-count"))
        .toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId("upload-cancel"));
    await waitFor(() =>
      expect(screen.queryByTestId("frame-extract-strategy-count")).toBeNull(),
    );
    expect(assetsApi.upload).not.toHaveBeenCalled();
  });
});
