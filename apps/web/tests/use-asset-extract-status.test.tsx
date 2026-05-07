// Armin Mehri — mehri.armin@gmail.com
import { describe, it, expect, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useBackgroundJobs } from "@/state/backgroundJobs";
import { useAssetExtractStatus } from "@/state/useAssetExtractStatus";

describe("useAssetExtractStatus", () => {
  beforeEach(() => {
    useBackgroundJobs.setState({ jobs: {}, expandRequest: null });
  });

  it("returns undefined when no job exists for the asset", () => {
    const { result } = renderHook(() => useAssetExtractStatus("asset-no-job"));
    expect(result.current).toBeUndefined();
  });

  it("returns extract progress for the asset's frame-extract job", () => {
    act(() => {
      useBackgroundJobs.getState().add({
        jobId: "j1",
        taskId: "t1",
        kind: "frame-extract",
        label: "Extracting frames",
        startedAt: Date.now(),
        assetId: "asset-A",
        cancel: async () => {},
        progress: {
          status: "running",
          phase: "decoding",
          decoded: 42,
          expected: 100,
          uploaded: 0,
        },
      });
    });

    const { result } = renderHook(() => useAssetExtractStatus("asset-A"));
    expect(result.current?.status).toBe("running");
    expect(result.current?.phase).toBe("decoding");
    expect(result.current?.decoded).toBe(42);
    expect(result.current?.expected).toBe(100);
  });

  it("ignores non-frame-extract jobs that share an assetId", () => {
    act(() => {
      useBackgroundJobs.getState().add({
        jobId: "j2",
        taskId: "t1",
        kind: "yolo-predict-batch",
        label: "YOLO",
        startedAt: Date.now(),
        assetId: "asset-A",
        cancel: async () => {},
        progress: { status: "running", done: 1, total: 10 },
      });
    });
    const { result } = renderHook(() => useAssetExtractStatus("asset-A"));
    expect(result.current).toBeUndefined();
  });

  it("returns undefined when assetId is undefined", () => {
    const { result } = renderHook(() => useAssetExtractStatus(undefined));
    expect(result.current).toBeUndefined();
  });
});
