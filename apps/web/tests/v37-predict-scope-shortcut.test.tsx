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
 * v3.7 Phase 2 Issues 1 + 2 — predict popover scope picker, batch
 * progress overlay, and the global Cmd/Ctrl+Enter quick-predict
 * shortcut. Each block wires a fresh ``EditorToolbar`` against mocked
 * ``inferenceApi`` / ``weightsApi`` and asserts the right call site
 * fires.
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
import {
  showToast,
  subscribeToasts,
  _resetToastBusForTests,
} from "@/lib/toast";

function wrap(node: React.ReactNode) {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: 0, gcTime: 0 },
    },
  });
  return (
    <QueryClientProvider client={qc}>
      <TooltipProvider>{node}</TooltipProvider>
    </QueryClientProvider>
  );
}

interface Handlers {
  onSave: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onZoomTo: (p: number) => void;
  onZoomActual: () => void;
  onFitToScreen: () => void;
}

function makeHandlers(): Handlers {
  return {
    onSave: vi.fn(),
    onZoomIn: vi.fn(),
    onZoomOut: vi.fn(),
    onZoomTo: vi.fn(),
    onZoomActual: vi.fn(),
    onFitToScreen: vi.fn(),
  };
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

const SAMPLE_SUGGESTIONS = {
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
  // Default: weights load, mapping suggestions fall back to a
  // single matched class.
  listForProjectMock.mockResolvedValue([SAMPLE_WEIGHT]);
  getMappingSuggestionsMock.mockResolvedValue(SAMPLE_SUGGESTIONS);
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
    total: 3,
    failed: 0,
    errors: [],
    total_annotations_created: 0,
    total_skipped_detections: 0,
  });
  useAnnotations.setState({
    history: { past: [], future: [] },
  } as never);
  // Ensure clean localStorage so prefilled selection is deterministic.
  try {
    window.localStorage.clear();
  } catch {
    /* private mode */
  }
});

afterEach(() => {
  cleanup();
});

function renderToolbar(opts?: {
  projectId?: string;
  taskId?: string;
  assetId?: string;
}): { onAfter: ReturnType<typeof vi.fn> } {
  const onAfter = vi.fn();
  const h = makeHandlers();
  render(
    wrap(
      <EditorToolbar
        onSave={h.onSave}
        isSaving={false}
        hasError={false}
        dirtyCount={0}
        zoomPct={100}
        projectId={opts?.projectId ?? "p1"}
        taskId={opts?.taskId ?? "t1"}
        assetId={opts?.assetId ?? "a1"}
        onZoomIn={h.onZoomIn}
        onZoomOut={h.onZoomOut}
        onZoomTo={h.onZoomTo}
        onZoomActual={h.onZoomActual}
        onFitToScreen={h.onFitToScreen}
        onAfterYoloPredict={onAfter}
      />,
    ),
  );
  return { onAfter };
}

// ---------------------------------------------------------------------------
// Issue 1 — scope picker, batch path, progress overlay, refetch.
// ---------------------------------------------------------------------------

describe("v3.7 Phase 2 Issue 1 — predict scope picker + batch overlay", () => {
  it("renders the scope picker with 'Current asset' selected by default", async () => {
    renderToolbar();
    fireEvent.click(screen.getByTestId("yolo-predict-trigger"));
    await waitFor(() => {
      expect(screen.getByTestId("yolo-predict-scope")).toBeInTheDocument();
    });
    const assetRadio = screen
      .getByTestId("yolo-predict-scope-asset")
      .querySelector('input[type="radio"]') as HTMLInputElement;
    const taskRadio = screen
      .getByTestId("yolo-predict-scope-task")
      .querySelector('input[type="radio"]') as HTMLInputElement;
    expect(assetRadio.checked).toBe(true);
    expect(taskRadio.checked).toBe(false);
  });

  it("switching scope to 'All assets in task' and submitting calls the batch endpoint", async () => {
    renderToolbar();
    fireEvent.click(screen.getByTestId("yolo-predict-trigger"));
    // Wait for the weight + scope picker to land.
    await waitFor(() => {
      expect(screen.getByTestId("yolo-predict-scope-task")).toBeInTheDocument();
    });
    // Switch to task scope.
    const taskRadio = screen
      .getByTestId("yolo-predict-scope-task")
      .querySelector('input[type="radio"]') as HTMLInputElement;
    fireEvent.click(taskRadio);
    // Wait for selected weight to seed (last-used / default).
    await waitFor(() => {
      const goButton = screen.getByTestId("yolo-predict-go") as HTMLButtonElement;
      expect(goButton.disabled).toBe(false);
    });
    fireEvent.click(screen.getByTestId("yolo-predict-go"));
    await waitFor(() => {
      expect(predictYoloBatchMock).toHaveBeenCalled();
    });
    // The call site uses (taskId, weightId, overwrite, confidence, classOverrides?).
    const [taskId, weightId] = predictYoloBatchMock.mock.calls[0];
    expect(taskId).toBe("t1");
    expect(weightId).toBe("w1");
    // Single-asset path must NOT have been called for batch scope.
    expect(predictYoloMock).not.toHaveBeenCalled();
  });

  it("opens the BatchPredictProgressOverlay after the batch enqueue resolves", async () => {
    renderToolbar();
    fireEvent.click(screen.getByTestId("yolo-predict-trigger"));
    await waitFor(() => {
      expect(screen.getByTestId("yolo-predict-scope-task")).toBeInTheDocument();
    });
    const taskRadio = screen
      .getByTestId("yolo-predict-scope-task")
      .querySelector('input[type="radio"]') as HTMLInputElement;
    fireEvent.click(taskRadio);
    await waitFor(() => {
      const goButton = screen.getByTestId("yolo-predict-go") as HTMLButtonElement;
      expect(goButton.disabled).toBe(false);
    });
    fireEvent.click(screen.getByTestId("yolo-predict-go"));
    await waitFor(() => {
      expect(screen.getByTestId("batch-predict-overlay")).toBeInTheDocument();
    });
    // Subtitle should announce N of M assets.
    await waitFor(() => {
      const subtitle = screen.getByTestId("batch-predict-subtitle");
      expect(subtitle.textContent).toMatch(/Predicting on .* of .* assets/i);
    });
  });

  it("dismisses overlay + fires summary toast when status==completed", async () => {
    // First poll: still running. Second: completed.
    pollBatchProgressMock
      .mockResolvedValueOnce({
        status: "running",
        done: 1,
        total: 3,
        failed: 0,
        errors: [],
        total_annotations_created: 2,
        total_skipped_detections: 0,
      })
      .mockResolvedValue({
        status: "completed",
        done: 3,
        total: 3,
        failed: 0,
        errors: [],
        total_annotations_created: 7,
        total_skipped_detections: 0,
      });

    const toasts: { message: string; variant: string }[] = [];
    const unsub = subscribeToasts((t) => {
      toasts.push({ message: t.message, variant: t.variant });
    });

    renderToolbar();
    fireEvent.click(screen.getByTestId("yolo-predict-trigger"));
    await waitFor(() => {
      expect(screen.getByTestId("yolo-predict-scope-task")).toBeInTheDocument();
    });
    fireEvent.click(
      screen
        .getByTestId("yolo-predict-scope-task")
        .querySelector('input[type="radio"]') as HTMLInputElement,
    );
    await waitFor(() => {
      const goButton = screen.getByTestId("yolo-predict-go") as HTMLButtonElement;
      expect(goButton.disabled).toBe(false);
    });
    fireEvent.click(screen.getByTestId("yolo-predict-go"));
    await waitFor(() => {
      expect(screen.getByTestId("batch-predict-overlay")).toBeInTheDocument();
    });
    // Wait for the overlay to dismiss after the terminal poll.
    await waitFor(
      () => {
        expect(
          screen.queryByTestId("batch-predict-overlay"),
        ).not.toBeInTheDocument();
      },
      { timeout: 5000 },
    );
    // Summary toast fired. v3.7.2 — text now reflects aggregate
    // created counts so the user can distinguish "completed but
    // produced nothing" from a successful batch.
    const summary = toasts.find((t) =>
      /Created \d+ annotations across \d+ of \d+ assets/i.test(t.message),
    );
    expect(summary).toBeTruthy();
    expect(summary?.variant).toBe("success");
    unsub();
  });

  it("Cancel button on the overlay closes it without further polling", async () => {
    renderToolbar();
    fireEvent.click(screen.getByTestId("yolo-predict-trigger"));
    await waitFor(() => {
      expect(screen.getByTestId("yolo-predict-scope-task")).toBeInTheDocument();
    });
    fireEvent.click(
      screen
        .getByTestId("yolo-predict-scope-task")
        .querySelector('input[type="radio"]') as HTMLInputElement,
    );
    await waitFor(() => {
      const goButton = screen.getByTestId("yolo-predict-go") as HTMLButtonElement;
      expect(goButton.disabled).toBe(false);
    });
    fireEvent.click(screen.getByTestId("yolo-predict-go"));
    await waitFor(() => {
      expect(screen.getByTestId("batch-predict-overlay")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("batch-predict-cancel"));
    await waitFor(() => {
      expect(
        screen.queryByTestId("batch-predict-overlay"),
      ).not.toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// Issue 2 — Cmd/Ctrl+Enter quick-predict + missing-config UX.
// ---------------------------------------------------------------------------

describe("v3.7 Phase 2 Issue 2 — Cmd/Ctrl+Enter quick predict", () => {
  it("Cmd+Enter fires single-asset predict when weight + mapping ready", async () => {
    renderToolbar();
    // Wait for the weight + mapping queries to settle so the
    // pre-flight has data (selected default weight + suggestions).
    await waitFor(() => {
      expect(listForProjectMock).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(getMappingSuggestionsMock).toHaveBeenCalled();
    });
    // Fire shortcut on the document.
    fireEvent.keyDown(window, {
      key: "Enter",
      metaKey: true,
    });
    await waitFor(() => {
      expect(predictYoloMock).toHaveBeenCalled();
    });
    const [assetId, weightId] = predictYoloMock.mock.calls[0];
    expect(assetId).toBe("a1");
    expect(weightId).toBe("w1");
  });

  it("Ctrl+Enter is treated identically to Cmd+Enter", async () => {
    renderToolbar();
    await waitFor(() => {
      expect(getMappingSuggestionsMock).toHaveBeenCalled();
    });
    fireEvent.keyDown(window, { key: "Enter", ctrlKey: true });
    await waitFor(() => {
      expect(predictYoloMock).toHaveBeenCalled();
    });
  });

  it("Cmd+Enter without any weights shows a toast and opens the popover", async () => {
    listForProjectMock.mockResolvedValue([]);

    const toasts: string[] = [];
    const unsub = subscribeToasts((t) => toasts.push(t.message));

    renderToolbar();
    await waitFor(() => {
      expect(listForProjectMock).toHaveBeenCalled();
    });
    fireEvent.keyDown(window, { key: "Enter", metaKey: true });
    await waitFor(() => {
      expect(toasts.some((m) => /No YOLO weight available/i.test(m))).toBe(true);
    });
    // The popover should have opened (so the user sees the empty hint).
    await waitFor(() => {
      expect(screen.getByTestId("yolo-empty-hint")).toBeInTheDocument();
    });
    expect(predictYoloMock).not.toHaveBeenCalled();
    unsub();
  });

  it("Cmd+Enter with no classes mapped shows a toast and expands mapping", async () => {
    // Suggestions exist but every weight class has null suggested id —
    // so no class is bound until the user picks something.
    getMappingSuggestionsMock.mockResolvedValue({
      suggestions: [
        {
          weight_class_idx: 0,
          weight_class_name: "thing",
          suggested_project_class_id: null,
          alternatives: [{ id: "c-other", name: "other" }],
        },
      ],
    });

    const toasts: string[] = [];
    const unsub = subscribeToasts((t) => toasts.push(t.message));

    renderToolbar();
    await waitFor(() => {
      expect(getMappingSuggestionsMock).toHaveBeenCalled();
    });
    fireEvent.keyDown(window, { key: "Enter", metaKey: true });
    await waitFor(() => {
      expect(toasts.some((m) => /No classes mapped/i.test(m))).toBe(true);
    });
    // Popover opened with the class-mapping disclosure expanded.
    await waitFor(() => {
      const toggle = screen.getByTestId("yolo-class-overrides-toggle");
      expect(toggle.getAttribute("aria-expanded")).toBe("true");
    });
    expect(predictYoloMock).not.toHaveBeenCalled();
    unsub();
  });

  it("the popover footer shows the ⌘+Enter shortcut hint", async () => {
    renderToolbar();
    fireEvent.click(screen.getByTestId("yolo-predict-trigger"));
    await waitFor(() => {
      expect(screen.getByTestId("yolo-predict-shortcut-hint")).toBeInTheDocument();
    });
    expect(
      screen.getByTestId("yolo-predict-shortcut-hint").textContent,
    ).toMatch(/Enter/i);
  });

  it("Cmd+Enter inside an INPUT element is ignored (no shortcut)", async () => {
    renderToolbar();
    await waitFor(() => {
      expect(getMappingSuggestionsMock).toHaveBeenCalled();
    });
    // Synthesise a keydown whose target is an INPUT element.
    const input = document.createElement("input");
    document.body.appendChild(input);
    fireEvent.keyDown(input, { key: "Enter", metaKey: true });
    // Give the handler a tick to run.
    await new Promise((r) => setTimeout(r, 30));
    expect(predictYoloMock).not.toHaveBeenCalled();
    document.body.removeChild(input);
  });
});

// Sanity: showToast is still wired (guards against accidentally
// breaking the toast bus across tests).
describe("toast bus sanity", () => {
  it("subscribers receive emitted messages", () => {
    const seen: string[] = [];
    const unsub = subscribeToasts((t) => seen.push(t.message));
    showToast("ok", { variant: "info" });
    expect(seen).toContain("ok");
    unsub();
  });
});
