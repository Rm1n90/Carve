import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/api/phase2", () => ({
  weightsApi: {
    retrainStart: vi.fn(),
    retrainStatus: vi.fn(),
    retrainCancel: vi.fn(),
  },
}));

import { weightsApi, type Weight, type RetrainStatus } from "@/api/phase2";
import { RetrainDialog } from "@/components/annotation/RetrainDialog";

const TASK = { id: "t1", name: "My Task" };

const WEIGHTS: Weight[] = [
  {
    id: "w-base-1",
    project_id: "p1",
    name: "yolov8-detect-v1",
    task_kind: "detect",
    minio_key: "weights/x.pt",
    size_bytes: 6_500_000,
    class_names: ["person", "car"],
    created_by: null,
    created_at: "2026-04-26T10:00:00+00:00",
    is_default: false,
  },
];

function wrap(node: React.ReactNode) {
  // retry: false so failed mutations surface immediately; gcTime: 0 so the
  // QueryClient doesn't cache between tests in the same module.
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  return <QueryClientProvider client={qc}>{node}</QueryClientProvider>;
}

afterEach(() => {
  cleanup();
  document.body.removeAttribute("data-scroll-locked");
  document.body.removeAttribute("style");
  vi.useRealTimers();
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("RetrainDialog", () => {
  it("renders form fields populated with sensible defaults", async () => {
    render(
      wrap(
        <RetrainDialog
          open
          onOpenChange={() => undefined}
          task={TASK}
          availableWeights={WEIGHTS}
        />,
      ),
    );

    await screen.findByText(/Retrain YOLO on this task/i);

    const baseSelect = screen.getByTestId(
      "retrain-base-weight",
    ) as HTMLSelectElement;
    expect(baseSelect.value).toBe(""); // (none — start from yolov8n.pt)
    // Includes both the empty option and the weight option.
    expect(baseSelect.querySelectorAll("option").length).toBe(2);

    const epochs = screen.getByTestId("retrain-epochs") as HTMLInputElement;
    expect(epochs.value).toBe("30");
    expect(epochs.min).toBe("1");
    expect(epochs.max).toBe("200");

    const imgsz = screen.getByTestId("retrain-imgsz") as HTMLSelectElement;
    expect(imgsz.value).toBe("640");
    const opts = Array.from(imgsz.querySelectorAll("option")).map((o) =>
      parseInt(o.value, 10),
    );
    expect(opts).toEqual([320, 416, 512, 640, 768, 896, 1024, 1280]);

    const includeProposed = screen.getByTestId(
      "retrain-include-proposed",
    ) as HTMLInputElement;
    expect(includeProposed.checked).toBe(false);

    const weightName = screen.getByTestId(
      "retrain-weight-name",
    ) as HTMLInputElement;
    expect(weightName.value).toBe("");
  });

  it("submit calls retrainStart with form values and transitions to polling state", async () => {
    (weightsApi.retrainStart as ReturnType<typeof vi.fn>).mockResolvedValue({
      job_id: "job-42",
    });
    (weightsApi.retrainStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      phase: "exporting",
      progress_pct: 5,
      error: null,
      error_traceback: null,
      weight_id: null,
    } satisfies RetrainStatus);

    render(
      wrap(
        <RetrainDialog
          open
          onOpenChange={() => undefined}
          task={TASK}
          availableWeights={WEIGHTS}
        />,
      ),
    );

    await screen.findByTestId("retrain-dialog-start");

    // Tweak the form before submitting.
    fireEvent.change(screen.getByTestId("retrain-base-weight"), {
      target: { value: "w-base-1" },
    });
    fireEvent.change(screen.getByTestId("retrain-epochs"), {
      target: { value: "50" },
    });
    fireEvent.change(screen.getByTestId("retrain-imgsz"), {
      target: { value: "768" },
    });
    fireEvent.click(screen.getByTestId("retrain-include-proposed"));
    fireEvent.change(screen.getByTestId("retrain-weight-name"), {
      target: { value: "my-new-weight" },
    });

    fireEvent.click(screen.getByTestId("retrain-dialog-start"));

    await waitFor(() => {
      expect(weightsApi.retrainStart).toHaveBeenCalledTimes(1);
    });
    const [taskId, body] = (
      weightsApi.retrainStart as ReturnType<typeof vi.fn>
    ).mock.calls[0];
    expect(taskId).toBe("t1");
    expect(body).toEqual({
      base_weight_id: "w-base-1",
      epochs: 50,
      imgsz: 768,
      include_proposed: true,
      weight_name: "my-new-weight",
    });

    // Once the mutation resolves the dialog flips to the progress view.
    await screen.findByTestId("retrain-progress");
    await screen.findByTestId("retrain-phase");
  });

  it("renders successive phases and surfaces success on done", async () => {
    (weightsApi.retrainStart as ReturnType<typeof vi.fn>).mockResolvedValue({
      job_id: "job-99",
    });
    const statusFn = weightsApi.retrainStatus as ReturnType<typeof vi.fn>;
    statusFn
      .mockResolvedValueOnce({
        phase: "training",
        progress_pct: 50,
        error: null,
        error_traceback: null,
        weight_id: null,
      } satisfies RetrainStatus)
      .mockResolvedValue({
        phase: "done",
        progress_pct: 100,
        error: null,
        error_traceback: null,
        weight_id: "w-new-1",
      } satisfies RetrainStatus);

    const onSuccess = vi.fn();

    render(
      wrap(
        <RetrainDialog
          open
          onOpenChange={() => undefined}
          task={TASK}
          availableWeights={WEIGHTS}
          onSuccess={onSuccess}
        />,
      ),
    );

    await screen.findByTestId("retrain-dialog-start");
    fireEvent.click(screen.getByTestId("retrain-dialog-start"));

    // First poll surfaces a running phase.
    await waitFor(() => {
      expect(screen.getByTestId("retrain-phase").textContent).toMatch(
        /training/i,
      );
    });

    // Second poll (refetched 1.5s later) surfaces the terminal "done"
    // state — wait long enough for the refetch interval to fire.
    await waitFor(
      () => {
        expect(screen.getByTestId("retrain-phase").textContent).toMatch(/done/i);
      },
      { timeout: 4000 },
    );

    // Success block + Use it button.
    await screen.findByTestId("retrain-success");
    fireEvent.click(screen.getByTestId("retrain-use-weight"));
    expect(onSuccess).toHaveBeenCalledWith("w-new-1");
  });

  it("shows the error text on the error phase", async () => {
    (weightsApi.retrainStart as ReturnType<typeof vi.fn>).mockResolvedValue({
      job_id: "job-err",
    });
    (weightsApi.retrainStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      phase: "error",
      progress_pct: 30,
      error: "Dataset export failed: empty task",
      error_traceback: "Traceback (most recent call last):\n  File ...",
      weight_id: null,
    } satisfies RetrainStatus);

    render(
      wrap(
        <RetrainDialog
          open
          onOpenChange={() => undefined}
          task={TASK}
          availableWeights={WEIGHTS}
        />,
      ),
    );

    await screen.findByTestId("retrain-dialog-start");
    fireEvent.click(screen.getByTestId("retrain-dialog-start"));

    const errBlock = await screen.findByTestId("retrain-error");
    expect(errBlock.textContent).toMatch(/Dataset export failed/);
    // Traceback collapsed into <details>.
    expect(errBlock.querySelector("details")?.textContent).toMatch(
      /Traceback/,
    );
  });

  it("cancel button calls retrainCancel and closes the dialog", async () => {
    (weightsApi.retrainStart as ReturnType<typeof vi.fn>).mockResolvedValue({
      job_id: "job-cancel",
    });
    (weightsApi.retrainStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      phase: "training",
      progress_pct: 20,
      error: null,
      error_traceback: null,
      weight_id: null,
    } satisfies RetrainStatus);
    (weightsApi.retrainCancel as ReturnType<typeof vi.fn>).mockResolvedValue(
      undefined,
    );

    const onOpenChange = vi.fn();

    render(
      wrap(
        <RetrainDialog
          open
          onOpenChange={onOpenChange}
          task={TASK}
          availableWeights={WEIGHTS}
        />,
      ),
    );

    await screen.findByTestId("retrain-dialog-start");
    fireEvent.click(screen.getByTestId("retrain-dialog-start"));

    const cancelBtn = await screen.findByTestId("retrain-dialog-cancel-job");
    fireEvent.click(cancelBtn);

    await waitFor(() => {
      expect(weightsApi.retrainCancel).toHaveBeenCalledWith(
        "t1",
        "job-cancel",
      );
    });
    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });
});
