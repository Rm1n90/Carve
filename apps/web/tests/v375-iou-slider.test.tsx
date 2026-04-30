import React from "react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@radix-ui/react-tooltip";

/**
 * v3.7.5 — IOU slider in the YOLO predict popover.
 *
 * Pins the new dial:
 *   1. The IOU slider renders below the confidence slider.
 *   2. Changing it updates the labeled value.
 *   3. Clicking Predict threads the IOU value through to the
 *      ``inferenceApi.predictYolo`` call (single-asset path).
 */

const samActiveMock = vi.fn().mockResolvedValue({
  active: "sam2.1-base+",
  available: ["sam2.1-base+"],
  reachable: true,
});

const listForProjectMock = vi.fn();
const getMappingSuggestionsMock = vi.fn();
const predictYoloMock = vi.fn();
const predictYoloBatchMock = vi.fn();
const pollBatchProgressMock = vi.fn();

vi.mock("@/api/phase2", () => ({
  modelsApi: {
    samActive: () => samActiveMock(),
    samStatus: vi.fn(),
    samSetActive: vi.fn(),
  },
  weightsApi: {
    listForProject: (...args: unknown[]) => listForProjectMock(...args),
    listWorkspace: vi.fn().mockResolvedValue([]),
    getMappingSuggestions: (...args: unknown[]) =>
      getMappingSuggestionsMock(...args),
  },
  inferenceApi: {
    predictYolo: (...args: unknown[]) => predictYoloMock(...args),
    predictYoloBatch: (...args: unknown[]) => predictYoloBatchMock(...args),
    pollBatchProgress: (...args: unknown[]) => pollBatchProgressMock(...args),
  },
  trashApi: { list: vi.fn(), restore: vi.fn(), hardDelete: vi.fn() },
}));

vi.mock("@/api/projects", () => ({
  projectsApi: { list: vi.fn().mockResolvedValue([]) },
}));

import { EditorToolbar } from "@/components/annotation/EditorToolbar";
import { useAnnotations } from "@/state/annotations";
import { _resetToastBusForTests } from "@/lib/toast";
import { ConfirmProvider } from "@/components/ui/ConfirmDialog";

function wrap(node: React.ReactNode) {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: 0, gcTime: 0 },
    },
  });
  return (
    <QueryClientProvider client={qc}>
      <ConfirmProvider>
        <TooltipProvider>{node}</TooltipProvider>
      </ConfirmProvider>
    </QueryClientProvider>
  );
}

const SAMPLE_WEIGHT = {
  id: "w1",
  project_id: "p1",
  name: "Detector",
  task_kind: "detect" as const,
  minio_key: "weights/x.pt",
  size_bytes: 1,
  class_names: ["car"],
  created_by: null,
  created_at: "2026-01-01",
  is_default: true,
};

const MAPPED_SUGGESTIONS = {
  suggestions: [
    {
      weight_class_idx: 0,
      weight_class_name: "car",
      suggested_project_class_id: "c-car",
      alternatives: [{ id: "c-car", name: "car" }],
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  _resetToastBusForTests();
  listForProjectMock.mockResolvedValue([SAMPLE_WEIGHT]);
  getMappingSuggestionsMock.mockResolvedValue(MAPPED_SUGGESTIONS);
  predictYoloMock.mockResolvedValue({
    count: 1,
    annotations_created: 1,
    skipped_count: 0,
    skipped_by_class: {},
    overwrite_skipped: false,
  });
  predictYoloBatchMock.mockResolvedValue({ job_id: "job-1" });
  pollBatchProgressMock.mockResolvedValue({
    status: "running",
    done: 0,
    total: 1,
    failed: 0,
    errors: [],
    total_annotations_created: 0,
    total_skipped_detections: 0,
  });
  useAnnotations.setState({
    history: { past: [], future: [] },
  } as never);
  try {
    window.localStorage.clear();
  } catch {
    /* private mode */
  }
});

afterEach(() => {
  cleanup();
});

function renderToolbar(): void {
  render(
    wrap(
      <EditorToolbar
        onSave={vi.fn()}
        isSaving={false}
        hasError={false}
        dirtyCount={0}
        zoomPct={100}
        projectId="p1"
        taskId="t1"
        assetId="a1"
        onZoomIn={vi.fn()}
        onZoomOut={vi.fn()}
        onZoomTo={vi.fn()}
        onZoomActual={vi.fn()}
        onFitToScreen={vi.fn()}
        onAfterYoloPredict={vi.fn()}
      />,
    ),
  );
}

describe("v3.7.5 — IOU threshold slider", () => {
  it("renders the IOU slider in the predict popover with default 70%", async () => {
    renderToolbar();
    fireEvent.click(screen.getByTestId("yolo-predict-trigger"));
    await waitFor(() => {
      expect(screen.getByTestId("yolo-iou-slider")).toBeInTheDocument();
    });
    const value = screen.getByTestId("yolo-iou-value");
    expect(value.textContent).toBe("70%");
    const slider = screen.getByTestId("yolo-iou-slider") as HTMLInputElement;
    expect(slider.getAttribute("aria-label")).toMatch(/IOU threshold/i);
    expect(slider.value).toBe("70");
  });

  it("threads the IOU value through to predictYolo when changed", async () => {
    renderToolbar();
    fireEvent.click(screen.getByTestId("yolo-predict-trigger"));
    await waitFor(() => {
      const goButton = screen.getByTestId(
        "yolo-predict-go",
      ) as HTMLButtonElement;
      expect(goButton.disabled).toBe(false);
    });

    // Drag the IOU slider to 50%.
    const slider = screen.getByTestId("yolo-iou-slider") as HTMLInputElement;
    fireEvent.change(slider, { target: { value: "50" } });
    await waitFor(() => {
      expect(screen.getByTestId("yolo-iou-value").textContent).toBe("50%");
    });

    // Fire predict.
    fireEvent.click(screen.getByTestId("yolo-predict-go"));

    await waitFor(() => {
      expect(predictYoloMock).toHaveBeenCalled();
    });

    // Sixth positional arg is `iou` per the predictYolo signature:
    // (assetId, weightId, overwrite, minConfidence, classOverrides?, iou).
    const lastCall = predictYoloMock.mock.calls[0];
    expect(lastCall[5]).toBeCloseTo(0.5, 5);
  });

  it("renders the IOU slider directly below the confidence slider", async () => {
    renderToolbar();
    fireEvent.click(screen.getByTestId("yolo-predict-trigger"));
    await waitFor(() => {
      expect(screen.getByTestId("yolo-confidence-slider")).toBeInTheDocument();
      expect(screen.getByTestId("yolo-iou-slider")).toBeInTheDocument();
    });
    const conf = screen.getByTestId("yolo-confidence-slider");
    const iou = screen.getByTestId("yolo-iou-slider");
    const pos = conf.compareDocumentPosition(iou);
    // DOCUMENT_POSITION_FOLLOWING = 4
    expect(pos & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
