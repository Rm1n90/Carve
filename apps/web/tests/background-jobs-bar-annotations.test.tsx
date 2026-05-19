// Armin Mehri — mehri.armin@gmail.com
/**
 * BackgroundJobsBar — annotation-batch invalidation contract.
 *
 * Defends the fix for the user-reported bug:
 *
 *   "When I do Auto annotation in batch sometimes the polygons don't
 *    show in the canvas even though it's already annotated and 20
 *    images pass from the image I'm checking. Always the first frame
 *    has this issue and other frames sometimes."
 *
 * Root cause: the bar polled every batch's progress endpoint but only
 * invalidated the asset-list / per-frame queries for ``isExtract``
 * jobs. For annotation-producing batches (sam-auto-text,
 * sam-auto-visual, yolo-predict-batch, yoloe-batch) the open editor's
 * ``["annotations", taskId, frameId]`` cache stayed populated with
 * the pre-batch snapshot until the user navigated away. Backgrounding
 * the dialog made it worse because the dialog's own
 * ``invalidateQueries`` calls never fired.
 *
 * Fix: on every progress poll where ``done`` grew (i.e. the worker
 * just finished one more asset), invalidate ``["annotations", taskId]``
 * and ``["task-annotations-raw", taskId]``. On terminal status,
 * additionally invalidate the asset-list / count queries.
 */
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/api/assets", () => ({
  assetsApi: { frameExtractStatus: vi.fn() },
}));
vi.mock("@/api/sam", () => ({
  samApi: { autoTextBatchProgress: vi.fn() },
}));
vi.mock("@/api/phase2", () => ({
  inferenceApi: { pollBatchProgress: vi.fn() },
}));
vi.mock("@/api/yoloe", () => ({ yoloeApi: { pollBatch: vi.fn() } }));
vi.mock("@/lib/toast", () => ({ showToast: vi.fn() }));

import { inferenceApi } from "@/api/phase2";
import { useBackgroundJobs } from "@/state/backgroundJobs";
import { BackgroundJobsBar } from "@/components/BackgroundJobsBar";

function makeQc(): { qc: QueryClient; spy: ReturnType<typeof vi.fn> } {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  });
  // Wrap invalidateQueries so we can assert on its calls without
  // colliding with our own internal refetches in the test setup.
  const original = qc.invalidateQueries.bind(qc);
  const spy = vi.fn(async (filters?: unknown) => original(filters as never));
  (qc as unknown as { invalidateQueries: typeof spy }).invalidateQueries =
    spy;
  return { qc, spy };
}

function wrap(node: React.ReactNode, qc: QueryClient) {
  return <QueryClientProvider client={qc}>{node}</QueryClientProvider>;
}

describe("BackgroundJobsBar — annotation-batch invalidation", () => {
  beforeEach(() => {
    useBackgroundJobs.setState({ jobs: {}, expandRequest: null });
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("invalidates ['annotations', taskId] when a yolo-predict-batch makes progress", async () => {
    // Arrange — first poll: done=5 (worker has finished 5 assets).
    (inferenceApi.pollBatchProgress as any).mockResolvedValue({
      status: "running",
      done: 5,
      total: 20,
      failed: 0,
      errors: [],
    });

    const { qc, spy } = makeQc();

    act(() => {
      useBackgroundJobs.getState().add({
        jobId: "j-yolo",
        taskId: "t-42",
        kind: "yolo-predict-batch",
        label: "YOLO predict",
        startedAt: Date.now(),
        cancel: async () => {},
      });
    });

    render(wrap(<BackgroundJobsBar />, qc));

    // Assert — the annotation cache must be invalidated so the
    // editor can refetch the asset the user is currently viewing.
    await waitFor(
      () => {
        const annotationsCall = spy.mock.calls.find((c) => {
          const filters = c[0] as { queryKey?: unknown[] } | undefined;
          return (
            Array.isArray(filters?.queryKey) &&
            filters.queryKey[0] === "annotations" &&
            filters.queryKey[1] === "t-42"
          );
        });
        expect(annotationsCall).toBeTruthy();
      },
      { timeout: 2000 },
    );

    // The task-annotations-raw cache (used by the right-rail Objects
    // panel and the task-wide health checks) also matters.
    const rawCall = spy.mock.calls.find((c) => {
      const filters = c[0] as { queryKey?: unknown[] } | undefined;
      return (
        Array.isArray(filters?.queryKey) &&
        filters.queryKey[0] === "task-annotations-raw" &&
        filters.queryKey[1] === "t-42"
      );
    });
    expect(rawCall).toBeTruthy();
  });

  it("does NOT re-invalidate when done is unchanged across two polls", async () => {
    // Arrange — both polls return the same ``done`` so the worker
    // hasn't produced anything new (e.g. waiting on the GPU queue).
    (inferenceApi.pollBatchProgress as any).mockResolvedValue({
      status: "running",
      done: 3,
      total: 20,
      failed: 0,
      errors: [],
    });

    const { qc, spy } = makeQc();

    act(() => {
      useBackgroundJobs.getState().add({
        jobId: "j-yolo-still",
        taskId: "t-stay",
        kind: "yolo-predict-batch",
        label: "YOLO predict",
        startedAt: Date.now(),
        cancel: async () => {},
      });
    });

    render(wrap(<BackgroundJobsBar />, qc));

    // Wait for the first poll → first invalidation.
    await waitFor(
      () => {
        const calls = spy.mock.calls.filter((c) => {
          const filters = c[0] as { queryKey?: unknown[] } | undefined;
          return (
            Array.isArray(filters?.queryKey) &&
            filters.queryKey[0] === "annotations" &&
            filters.queryKey[1] === "t-stay"
          );
        });
        expect(calls.length).toBeGreaterThanOrEqual(1);
      },
      { timeout: 2000 },
    );

    // Snapshot the count, wait long enough that a second poll
    // would have run, then verify no NEW annotation invalidation
    // happened (the ``done`` counter didn't grow).
    const annotationCallsAfterFirst = spy.mock.calls.filter((c) => {
      const filters = c[0] as { queryKey?: unknown[] } | undefined;
      return (
        Array.isArray(filters?.queryKey) &&
        filters.queryKey[0] === "annotations" &&
        filters.queryKey[1] === "t-stay"
      );
    }).length;

    // The bar's poll interval is ~1.5s. Wait 2s.
    await new Promise((r) => setTimeout(r, 2000));

    const annotationCallsLater = spy.mock.calls.filter((c) => {
      const filters = c[0] as { queryKey?: unknown[] } | undefined;
      return (
        Array.isArray(filters?.queryKey) &&
        filters.queryKey[0] === "annotations" &&
        filters.queryKey[1] === "t-stay"
      );
    }).length;

    expect(annotationCallsLater).toBe(annotationCallsAfterFirst);
  });

  it("invalidates task-assets on terminal status (completed)", async () => {
    // Arrange
    (inferenceApi.pollBatchProgress as any).mockResolvedValue({
      status: "completed",
      done: 20,
      total: 20,
      failed: 0,
      errors: [],
    });

    const { qc, spy } = makeQc();

    act(() => {
      useBackgroundJobs.getState().add({
        jobId: "j-done",
        taskId: "t-done",
        kind: "yolo-predict-batch",
        label: "YOLO predict",
        startedAt: Date.now(),
        cancel: async () => {},
      });
    });

    render(wrap(<BackgroundJobsBar />, qc));

    await waitFor(
      () => {
        const assetsCall = spy.mock.calls.find((c) => {
          const filters = c[0] as { queryKey?: unknown[] } | undefined;
          return (
            Array.isArray(filters?.queryKey) &&
            filters.queryKey[0] === "task-assets" &&
            filters.queryKey[1] === "t-done"
          );
        });
        expect(assetsCall).toBeTruthy();
      },
      { timeout: 2000 },
    );
  });
});
