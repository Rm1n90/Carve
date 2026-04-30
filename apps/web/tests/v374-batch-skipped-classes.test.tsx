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
 * v3.7.4 — post-batch toast names the unmapped classes.
 *
 * Background: a v3.7.3 batch reported "Skipped 297 detections (unmapped
 * classes)" but never named the classes — users couldn't tell whether
 * to map ``person``, ``boat``, ``train``, ``kite``, or ``bottle``. The
 * fix piggybacks ``skipped_by_class: Record<string, number>`` on the
 * progress shape and renders the top-N entries in the post-batch toast.
 *
 * This file pins three behaviours:
 *
 *   1. Top classes are listed in the toast in count-descending order.
 *   2. Long lists are capped at 5 with a "+ N more" suffix so the toast
 *      stays readable.
 *   3. When ``skipped_by_class`` is empty (e.g. legacy worker), the
 *      toast falls back to the v3.7.2 "Skipped N detections (unmapped
 *      classes)" wording instead of rendering "[]" or noise.
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
  predictYoloBatchMock.mockResolvedValue({ job_id: "job-1" });
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

function renderToolbar(): { onAfter: ReturnType<typeof vi.fn> } {
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
        projectId="p1"
        taskId="t1"
        assetId="a1"
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

async function runBatchAndCaptureToast(): Promise<
  { message: string; variant: string }[]
> {
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
  await waitFor(
    () => {
      expect(
        screen.queryByTestId("batch-predict-overlay"),
      ).not.toBeInTheDocument();
    },
    { timeout: 5000 },
  );
  unsub();
  return toasts;
}

// ---------------------------------------------------------------------------
// 1 — Toast names the top-N skipped classes (count-descending)
// ---------------------------------------------------------------------------

describe("v3.7.4 — toast names unmapped classes", () => {
  it("lists top classes by count (motorcycle, person, boat) when skips are present", async () => {
    pollBatchProgressMock
      .mockResolvedValueOnce({
        status: "running",
        done: 0,
        total: 5,
        failed: 0,
        errors: [],
        total_annotations_created: 0,
        total_skipped_detections: 160,
        skipped_by_class: { motorcycle: 100, person: 50, boat: 10 },
      })
      .mockResolvedValue({
        status: "completed",
        done: 5,
        total: 5,
        failed: 0,
        errors: [],
        total_annotations_created: 0,
        total_skipped_detections: 160,
        skipped_by_class: { motorcycle: 100, person: 50, boat: 10 },
      });

    const toasts = await runBatchAndCaptureToast();
    const summary = toasts.find((t) =>
      /Created 0 annotations across 5 of 5 assets/i.test(t.message),
    );
    expect(summary).toBeTruthy();
    expect(summary!.message).toMatch(/motorcycle \(100\)/);
    expect(summary!.message).toMatch(/person \(50\)/);
    expect(summary!.message).toMatch(/boat \(10\)/);
    // Order is count-descending so the highest-impact class is first.
    const idxMoto = summary!.message.indexOf("motorcycle (100)");
    const idxPerson = summary!.message.indexOf("person (50)");
    const idxBoat = summary!.message.indexOf("boat (10)");
    expect(idxMoto).toBeLessThan(idxPerson);
    expect(idxPerson).toBeLessThan(idxBoat);
    // CTA pointing the user to class mapping.
    expect(summary!.message).toMatch(/Open Class mapping/i);
    // Variant is warning when skipped > 0 even with created == 0.
    expect(summary!.variant).toBe("warning");
  });

  it("caps the displayed list at 5 with a '+ N more' suffix for long tails", async () => {
    pollBatchProgressMock
      .mockResolvedValueOnce({
        status: "running",
        done: 0,
        total: 7,
        failed: 0,
        errors: [],
        total_annotations_created: 0,
        total_skipped_detections: 28,
        skipped_by_class: {
          motorcycle: 10,
          person: 8,
          boat: 5,
          kite: 2,
          bottle: 1,
          train: 1,
          dog: 1,
        },
      })
      .mockResolvedValue({
        status: "completed",
        done: 7,
        total: 7,
        failed: 0,
        errors: [],
        total_annotations_created: 0,
        total_skipped_detections: 28,
        skipped_by_class: {
          motorcycle: 10,
          person: 8,
          boat: 5,
          kite: 2,
          bottle: 1,
          train: 1,
          dog: 1,
        },
      });

    const toasts = await runBatchAndCaptureToast();
    const summary = toasts.find((t) =>
      /Created 0 annotations/.test(t.message),
    );
    expect(summary).toBeTruthy();
    // Top-5 are present.
    expect(summary!.message).toMatch(/motorcycle \(10\)/);
    expect(summary!.message).toMatch(/person \(8\)/);
    expect(summary!.message).toMatch(/boat \(5\)/);
    expect(summary!.message).toMatch(/kite \(2\)/);
    expect(summary!.message).toMatch(/bottle \(1\)/);
    // Tail is summarised: 7 entries - 5 top = 2 more.
    expect(summary!.message).toMatch(/\+ 2 more/);
  });

  it("falls back to the v3.7.2 wording when skipped_by_class is empty", async () => {
    pollBatchProgressMock
      .mockResolvedValueOnce({
        status: "running",
        done: 0,
        total: 3,
        failed: 0,
        errors: [],
        total_annotations_created: 0,
        total_skipped_detections: 9,
        skipped_by_class: {},
      })
      .mockResolvedValue({
        status: "completed",
        done: 3,
        total: 3,
        failed: 0,
        errors: [],
        total_annotations_created: 0,
        total_skipped_detections: 9,
        skipped_by_class: {},
      });

    const toasts = await runBatchAndCaptureToast();
    const summary = toasts.find((t) =>
      /Created 0 annotations across 3 of 3 assets/i.test(t.message),
    );
    expect(summary).toBeTruthy();
    expect(summary!.message).toMatch(/Skipped 9 detections \(unmapped classes\)/i);
    // No spurious "Open Class mapping" since we have no names to point at.
    expect(summary!.message).not.toMatch(/Open Class mapping/);
    expect(summary!.variant).toBe("warning");
  });

  it("omits the skipped-line entirely when there were no skips", async () => {
    pollBatchProgressMock
      .mockResolvedValueOnce({
        status: "running",
        done: 2,
        total: 5,
        failed: 0,
        errors: [],
        total_annotations_created: 4,
        total_skipped_detections: 0,
        skipped_by_class: {},
      })
      .mockResolvedValue({
        status: "completed",
        done: 5,
        total: 5,
        failed: 0,
        errors: [],
        total_annotations_created: 12,
        total_skipped_detections: 0,
        skipped_by_class: {},
      });

    const toasts = await runBatchAndCaptureToast();
    const summary = toasts.find((t) =>
      /Created 12 annotations across 5 of 5 assets/i.test(t.message),
    );
    expect(summary).toBeTruthy();
    expect(summary!.message).not.toMatch(/Skipped/);
    expect(summary!.variant).toBe("success");
  });
});
