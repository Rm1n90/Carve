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
 * v3.7.2 — overwrite-safety frontend coverage.
 *
 * Three guarantees this file pins:
 *
 *   1. Pre-flight: when zero weight classes are mapped, the popover
 *      shows a warning banner ABOVE the Predict button and the button
 *      is DISABLED. The user cannot fire a no-op predict that would
 *      have wiped their existing annotations on the pre-fix code path.
 *
 *   2. Confirm-before-batch: overwrite=true + scope="task" routes
 *      through ``useConfirm()`` so the user explicitly approves the
 *      destructive action across an entire task.
 *
 *   3. Post-batch toast clarity: the summary toast surfaces the new
 *      ``total_annotations_created`` field, so a "completed but
 *      produced nothing" batch (the original data-loss scenario) is
 *      visually distinct from a successful one.
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

const UNMAPPED_SUGGESTIONS = {
  suggestions: [
    {
      weight_class_idx: 0,
      weight_class_name: "person",
      suggested_project_class_id: null,
      alternatives: [{ id: "c-other", name: "other" }],
    },
    {
      weight_class_idx: 1,
      weight_class_name: "bicycle",
      suggested_project_class_id: null,
      alternatives: [{ id: "c-other", name: "other" }],
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
    total: 3,
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
// 3a — Pre-flight warning + disabled Predict when zero classes are mapped
// ---------------------------------------------------------------------------

describe("v3.7.2 — pre-flight: no-class-mapping warning + disabled Predict", () => {
  it("renders the warning banner when zero weight classes are mapped", async () => {
    getMappingSuggestionsMock.mockResolvedValue(UNMAPPED_SUGGESTIONS);
    renderToolbar();
    fireEvent.click(screen.getByTestId("yolo-predict-trigger"));
    await waitFor(() => {
      expect(getMappingSuggestionsMock).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(
        screen.getByTestId("yolo-no-mapping-warning"),
      ).toBeInTheDocument();
    });
    const banner = screen.getByTestId("yolo-no-mapping-warning");
    // Both the count and the explanation are surfaced so the user
    // understands why nothing would be created.
    expect(banner.textContent).toMatch(/0 of 2 weight classes/i);
    expect(banner.textContent).toMatch(/skip all detections/i);
  });

  it("disables the Predict button when zero classes are mapped", async () => {
    getMappingSuggestionsMock.mockResolvedValue(UNMAPPED_SUGGESTIONS);
    renderToolbar();
    fireEvent.click(screen.getByTestId("yolo-predict-trigger"));
    await waitFor(() => {
      expect(getMappingSuggestionsMock).toHaveBeenCalled();
    });
    await waitFor(() => {
      const goButton = screen.getByTestId(
        "yolo-predict-go",
      ) as HTMLButtonElement;
      expect(goButton.disabled).toBe(true);
    });
    // A tooltip-y title attribute hints why it's disabled so a click
    // attempt by a user paying attention surfaces the reason.
    const goButton = screen.getByTestId("yolo-predict-go");
    expect(goButton.getAttribute("title")).toMatch(
      /Map at least one class/i,
    );
  });

  it("Predict button is enabled when at least one class is mapped", async () => {
    // Default beforeEach uses MAPPED_SUGGESTIONS — sanity check.
    renderToolbar();
    fireEvent.click(screen.getByTestId("yolo-predict-trigger"));
    await waitFor(() => {
      expect(getMappingSuggestionsMock).toHaveBeenCalled();
    });
    await waitFor(() => {
      const goButton = screen.getByTestId(
        "yolo-predict-go",
      ) as HTMLButtonElement;
      expect(goButton.disabled).toBe(false);
    });
    expect(
      screen.queryByTestId("yolo-no-mapping-warning"),
    ).not.toBeInTheDocument();
  });

  it("disabled button has the expected attribute set so React suppresses onClick", async () => {
    getMappingSuggestionsMock.mockResolvedValue(UNMAPPED_SUGGESTIONS);
    renderToolbar();
    fireEvent.click(screen.getByTestId("yolo-predict-trigger"));
    await waitFor(() => {
      const goButton = screen.getByTestId(
        "yolo-predict-go",
      ) as HTMLButtonElement;
      expect(goButton.disabled).toBe(true);
      // The disabled HTML attribute is the contract React uses to
      // suppress click handlers — assert it directly so this test
      // pins the actual attribute, not just the prop value.
      expect(goButton.hasAttribute("disabled")).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// 3b — Confirm dialog when overwrite=true + scope=task
// ---------------------------------------------------------------------------

describe("v3.7.2 — confirm dialog for overwrite + batch scope", () => {
  async function openPopoverAndSwitchToTaskScope() {
    fireEvent.click(screen.getByTestId("yolo-predict-trigger"));
    await waitFor(() => {
      expect(screen.getByTestId("yolo-predict-scope-task")).toBeInTheDocument();
    });
    const taskRadio = screen
      .getByTestId("yolo-predict-scope-task")
      .querySelector('input[type="radio"]') as HTMLInputElement;
    fireEvent.click(taskRadio);
    // Wait for the selected weight + suggestions so Predict is enabled.
    await waitFor(() => {
      const goButton = screen.getByTestId(
        "yolo-predict-go",
      ) as HTMLButtonElement;
      expect(goButton.disabled).toBe(false);
    });
  }

  it("opens a confirm dialog before firing batch when overwrite=true + task scope", async () => {
    renderToolbar();
    await openPopoverAndSwitchToTaskScope();
    // Toggle overwrite ON.
    const overwriteCheckbox = screen
      .getByText(/Overwrite existing annotations/i)
      .closest("label")
      ?.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(overwriteCheckbox).toBeTruthy();
    fireEvent.click(overwriteCheckbox);
    expect(overwriteCheckbox.checked).toBe(true);

    // Click Predict.
    fireEvent.click(screen.getByTestId("yolo-predict-go"));

    // The confirm dialog must open before the batch endpoint is called.
    await waitFor(() => {
      expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    });
    expect(predictYoloBatchMock).not.toHaveBeenCalled();
    // Copy must mention the safety net so users understand what happens
    // on assets with no matches.
    const dialog = screen.getByRole("alertdialog");
    expect(dialog.textContent).toMatch(/REPLACE existing annotations/i);
    expect(dialog.textContent).toMatch(/no matches will be preserved/i);
  });

  it("clicking Cancel on confirm does NOT fire the batch", async () => {
    renderToolbar();
    await openPopoverAndSwitchToTaskScope();
    const overwriteCheckbox = screen
      .getByText(/Overwrite existing annotations/i)
      .closest("label")
      ?.querySelector('input[type="checkbox"]') as HTMLInputElement;
    fireEvent.click(overwriteCheckbox);
    fireEvent.click(screen.getByTestId("yolo-predict-go"));
    await waitFor(() => {
      expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("confirm-dialog-cancel"));
    await new Promise((r) => setTimeout(r, 50));
    expect(predictYoloBatchMock).not.toHaveBeenCalled();
  });

  it("clicking Confirm on the dialog DOES fire the batch", async () => {
    renderToolbar();
    await openPopoverAndSwitchToTaskScope();
    const overwriteCheckbox = screen
      .getByText(/Overwrite existing annotations/i)
      .closest("label")
      ?.querySelector('input[type="checkbox"]') as HTMLInputElement;
    fireEvent.click(overwriteCheckbox);
    fireEvent.click(screen.getByTestId("yolo-predict-go"));
    await waitFor(() => {
      expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("confirm-dialog-confirm"));
    await waitFor(() => {
      expect(predictYoloBatchMock).toHaveBeenCalled();
    });
  });

  it("overwrite=false + task scope does NOT show a confirm dialog", async () => {
    renderToolbar();
    await openPopoverAndSwitchToTaskScope();
    // overwrite stays unchecked (default false).
    fireEvent.click(screen.getByTestId("yolo-predict-go"));
    await waitFor(() => {
      expect(predictYoloBatchMock).toHaveBeenCalled();
    });
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// 3c — Post-batch toast clarity (uses new aggregate count fields)
// ---------------------------------------------------------------------------

describe("v3.7.2 — post-batch toast surfaces aggregate created count", () => {
  it("toast mentions zero-created when the batch produced nothing", async () => {
    pollBatchProgressMock
      .mockResolvedValueOnce({
        status: "running",
        done: 0,
        total: 3,
        failed: 0,
        errors: [],
        total_annotations_created: 0,
        total_skipped_detections: 9,
      })
      .mockResolvedValue({
        status: "completed",
        done: 3,
        total: 3,
        failed: 0,
        errors: [],
        total_annotations_created: 0,
        total_skipped_detections: 9,
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
      const goButton = screen.getByTestId(
        "yolo-predict-go",
      ) as HTMLButtonElement;
      expect(goButton.disabled).toBe(false);
    });
    fireEvent.click(screen.getByTestId("yolo-predict-go"));
    await waitFor(() => {
      expect(screen.getByTestId("batch-predict-overlay")).toBeInTheDocument();
    });
    await waitFor(
      () => {
        expect(
          screen.queryByTestId("batch-predict-overlay"),
        ).not.toBeInTheDocument();
      },
      { timeout: 5000 },
    );
    // Toast must surface "Created 0 annotations" so the user can tell
    // a no-op batch from a successful one.
    const summary = toasts.find((t) =>
      /Created 0 annotations across 3 of 3 assets/i.test(t.message),
    );
    expect(summary).toBeTruthy();
    // Skipped detection count surfaced too.
    expect(summary?.message).toMatch(/Skipped 9 detections/i);
    // Variant downgrades to warning when nothing was created.
    expect(summary?.variant).toBe("warning");
    unsub();
  });

  it("toast shows positive summary when batch produced annotations", async () => {
    pollBatchProgressMock
      .mockResolvedValueOnce({
        status: "running",
        done: 2,
        total: 5,
        failed: 0,
        errors: [],
        total_annotations_created: 4,
        total_skipped_detections: 0,
      })
      .mockResolvedValue({
        status: "completed",
        done: 5,
        total: 5,
        failed: 0,
        errors: [],
        total_annotations_created: 12,
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
      const goButton = screen.getByTestId(
        "yolo-predict-go",
      ) as HTMLButtonElement;
      expect(goButton.disabled).toBe(false);
    });
    fireEvent.click(screen.getByTestId("yolo-predict-go"));
    // Wait for the overlay to mount first, then for it to dismiss
    // after the terminal poll. Skipping the mount-wait races the
    // "completed" poll against the overlay-render and the summary
    // toast can be missed.
    await waitFor(() => {
      expect(screen.getByTestId("batch-predict-overlay")).toBeInTheDocument();
    });
    await waitFor(
      () => {
        expect(
          screen.queryByTestId("batch-predict-overlay"),
        ).not.toBeInTheDocument();
      },
      { timeout: 5000 },
    );
    const summary = toasts.find((t) =>
      /Created 12 annotations across 5 of 5 assets/i.test(t.message),
    );
    expect(summary).toBeTruthy();
    expect(summary?.variant).toBe("success");
    unsub();
  });

  it("single-asset overwrite=true with zero detections shows preserve-toast", async () => {
    // The backend signals the data-loss-prevention path via
    // ``overwrite_skipped: true``. The frontend must surface a clear
    // warning so the user knows their existing annotations are intact.
    predictYoloMock.mockResolvedValue({
      count: 0,
      annotations_created: 0,
      skipped_count: 3,
      skipped_by_class: { person: 1, dog: 1, cat: 1 },
      overwrite_skipped: true,
    });

    const toasts: { message: string; variant: string }[] = [];
    const unsub = subscribeToasts((t) => {
      toasts.push({ message: t.message, variant: t.variant });
    });

    renderToolbar();
    fireEvent.click(screen.getByTestId("yolo-predict-trigger"));
    await waitFor(() => {
      const goButton = screen.getByTestId(
        "yolo-predict-go",
      ) as HTMLButtonElement;
      expect(goButton.disabled).toBe(false);
    });
    // Toggle overwrite ON.
    const overwriteCheckbox = screen
      .getByText(/Overwrite existing annotations/i)
      .closest("label")
      ?.querySelector('input[type="checkbox"]') as HTMLInputElement;
    fireEvent.click(overwriteCheckbox);
    fireEvent.click(screen.getByTestId("yolo-predict-go"));
    await waitFor(() => {
      const t = toasts.find((x) =>
        /Existing annotations were preserved/i.test(x.message),
      );
      expect(t).toBeTruthy();
      expect(t?.variant).toBe("warning");
    });
    unsub();
  });
});

// Sanity: showToast bus still wired across this test file.
describe("v3.7.2 toast bus sanity", () => {
  it("subscribers receive emitted messages", () => {
    const seen: string[] = [];
    const unsub = subscribeToasts((t) => seen.push(t.message));
    showToast("hi", { variant: "info" });
    expect(seen).toContain("hi");
    unsub();
  });
});
