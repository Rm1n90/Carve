// Armin Mehri — mehri.armin@gmail.com
/**
 * Logo AI score filter.
 *
 * Asserts:
 *   - which boxes the thresholds spare: a person's, an accepted one, and
 *     one scored exactly on the line
 *   - opening the popover previews the thresholds on the canvas (via the
 *     filter store) and closing it stops
 *   - the counts for the open image come from the editor's own boxes
 *   - removing asks first, then calls the API scoped to the open image
 *   - editing a scored box clears its scores, taking it out of the filter
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/api/logoAi", async () => {
  const actual =
    await vi.importActual<typeof import("@/api/logoAi")>("@/api/logoAi");
  return {
    ...actual,
    logoAiApi: { filterPreview: vi.fn(), filterApply: vi.fn() },
  };
});
vi.mock("@/lib/toast", () => ({ showToast: vi.fn() }));
const confirmMock = vi.fn();
vi.mock("@/components/ui/ConfirmDialog", () => ({
  useConfirm: () => confirmMock,
}));

import { logoAiApi } from "@/api/logoAi";
import { showToast } from "@/lib/toast";
import { LogoAiFilter } from "@/components/annotation/LogoAiFilter";
import {
  evaluateFilter,
  passesScoreThresholds,
  type FilterGroup,
} from "@/lib/annotation-filter";
import { useFilter } from "@/state/annotationFilter";
import { useAnnotations, type AnnotationDraft } from "@/state/annotations";
import { useDialogPrefs } from "@/state/dialogPrefs";

const api = logoAiApi as unknown as Record<"filterPreview" | "filterApply", ReturnType<typeof vi.fn>>;

function box(id: string, extra: Partial<AnnotationDraft> = {}): AnnotationDraft {
  return {
    tempId: id,
    serverId: id,
    classId: "c1",
    kind: "bbox",
    geometry: { kind: "bbox", x: 0, y: 0, w: 10, h: 10 },
    frameId: "f1",
    dirty: false,
    status: "proposed",
    ...extra,
  };
}

const BOXES = [
  box("clear", { confidence: 0.9, visible: 100 }),
  box("edge", { confidence: 0.8, visible: 60 }),
  box("unsure", { confidence: 0.7, visible: 100 }),
  box("hidden", { confidence: 0.9, visible: 40 }),
  box("accepted", { confidence: 0.4, visible: 20, status: "accepted" }),
  box("drawn"),
];

function renderFilter(onApplied = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <LogoAiFilter taskId="t1" assetId="a1" onApplied={onApplied} />
    </QueryClientProvider>,
  );
  return { onApplied };
}

beforeEach(() => {
  vi.clearAllMocks();
  useFilter.setState({ filter: null, scorePreview: null });
  useDialogPrefs.setState({ logoAiByTask: {} });
  useAnnotations.setState({
    byId: Object.fromEntries(BOXES.map((b) => [b.tempId, b])),
  });
  api.filterPreview.mockResolvedValue({ scored: 120, below: 35, assets: 9, applied: false });
});

afterEach(() => {
  cleanup();
});

describe("passesScoreThresholds", () => {
  const t = { minConfidence: 0.8, minVisible: 60 };
  it("spares unscored and accepted boxes and keeps one exactly on the line", () => {
    const kept = BOXES.filter((b) => passesScoreThresholds(b, t)).map((b) => b.tempId);
    expect(kept).toEqual(["clear", "edge", "accepted", "drawn"]);
  });
  it("passes everything when no thresholds are set", () => {
    expect(BOXES.every((b) => passesScoreThresholds(b, null))).toBe(true);
  });
});

describe("annotation filter score fields", () => {
  it("match only boxes that carry a score", () => {
    const lowConfidence: FilterGroup = {
      combinator: "AND",
      rules: [{ not: false, field: "confidence", op: "<", value: 0.8 }],
    };
    const matched = BOXES.filter((b) => evaluateFilter(b, {}, lowConfidence)).map((b) => b.tempId);
    // The hand-drawn box has no confidence, so it is not "low confidence".
    expect(matched).toEqual(["unsure", "accepted"]);

    const mostlyHidden: FilterGroup = {
      combinator: "AND",
      rules: [{ not: false, field: "visible", op: "<", value: 50 }],
    };
    expect(
      BOXES.filter((b) => evaluateFilter(b, {}, mostlyHidden)).map((b) => b.tempId),
    ).toEqual(["hidden", "accepted"]);
  });
});

describe("LogoAiFilter", () => {
  it("previews on the canvas only while open", async () => {
    renderFilter();
    expect(useFilter.getState().scorePreview).toBeNull();

    fireEvent.click(screen.getByTestId("logo-ai-filter-open"));
    await screen.findByTestId("logo-ai-filter");
    expect(useFilter.getState().scorePreview).toEqual({ minConfidence: 0.7, minVisible: 60 });

    fireEvent.change(screen.getByTestId("logo-ai-filter-confidence"), {
      target: { value: "0.8" },
    });
    fireEvent.change(screen.getByTestId("logo-ai-filter-visible"), { target: { value: "60" } });
    expect(useFilter.getState().scorePreview).toEqual({ minConfidence: 0.8, minVisible: 60 });
    // The user's own rule filter is left alone.
    expect(useFilter.getState().filter).toBeNull();

    fireEvent.click(screen.getByTestId("logo-ai-filter-open"));
    await waitFor(() => expect(useFilter.getState().scorePreview).toBeNull());
  });

  it("starts from the thresholds the last run used", async () => {
    useDialogPrefs.setState({
      logoAiByTask: {
        t1: {
          provider: "openai", model: "gpt-6.1-sol", effort: "low", rows: [],
          detail: "max", tiling: "off", minConfidence: 0.3, minVisible: 40,
          overwrite: false, skipAnnotated: false, delivery: "realtime", flex: false,
          scope: "this",
        },
      },
    });
    renderFilter();
    fireEvent.click(screen.getByTestId("logo-ai-filter-open"));
    await screen.findByTestId("logo-ai-filter");
    await waitFor(() =>
      expect(useFilter.getState().scorePreview).toEqual({ minConfidence: 0.3, minVisible: 40 }),
    );
  });

  it("counts the open image locally and the task on the server", async () => {
    renderFilter();
    fireEvent.click(screen.getByTestId("logo-ai-filter-open"));
    fireEvent.change(await screen.findByTestId("logo-ai-filter-confidence"), {
      target: { value: "0.8" },
    });
    fireEvent.change(screen.getByTestId("logo-ai-filter-visible"), { target: { value: "60" } });

    // Four candidates (not the accepted or the drawn one); two survive.
    expect(screen.getByTestId("logo-ai-filter-here").textContent).toBe(
      "This image: keeps 2 of 4",
    );
    await waitFor(() =>
      expect(api.filterPreview).toHaveBeenLastCalledWith("t1", {
        min_confidence: 0.8,
        min_visible: 60,
      }),
    );
    await waitFor(() =>
      expect(screen.getByTestId("logo-ai-filter-task").textContent).toBe(
        "Whole task: keeps 85 of 120",
      ),
    );
  });

  it("asks before removing, then removes on this image only", async () => {
    api.filterApply.mockResolvedValue({ scored: 4, below: 2, assets: 1, applied: true });
    const { onApplied } = renderFilter();
    fireEvent.click(screen.getByTestId("logo-ai-filter-open"));
    fireEvent.change(await screen.findByTestId("logo-ai-filter-confidence"), {
      target: { value: "0.8" },
    });
    fireEvent.change(screen.getByTestId("logo-ai-filter-visible"), { target: { value: "60" } });

    confirmMock.mockResolvedValueOnce(false);
    fireEvent.click(screen.getByTestId("logo-ai-filter-apply-image"));
    await waitFor(() => expect(confirmMock).toHaveBeenCalledTimes(1));
    expect(confirmMock.mock.calls[0][0].title).toBe("Remove 2 boxes?");
    expect(api.filterApply).not.toHaveBeenCalled();

    confirmMock.mockResolvedValueOnce(true);
    fireEvent.click(screen.getByTestId("logo-ai-filter-apply-image"));
    await waitFor(() =>
      expect(api.filterApply).toHaveBeenCalledWith("t1", {
        min_confidence: 0.8,
        min_visible: 60,
        asset_ids: ["a1"],
      }),
    );
    await waitFor(() => expect(onApplied).toHaveBeenCalled());
  });

  it("removes across the task without an asset scope", async () => {
    api.filterApply.mockResolvedValue({ scored: 120, below: 35, assets: 9, applied: true });
    renderFilter();
    fireEvent.click(screen.getByTestId("logo-ai-filter-open"));
    const button = await screen.findByTestId("logo-ai-filter-apply-task");
    await waitFor(() => expect(button.textContent).toBe("Remove 35"));
    confirmMock.mockResolvedValueOnce(true);
    fireEvent.click(button);
    await waitFor(() => expect(api.filterApply).toHaveBeenCalledTimes(1));
    expect(api.filterApply.mock.calls[0][1]).not.toHaveProperty("asset_ids");
    expect(confirmMock.mock.calls[0][0].description).toContain("across 9 images");
  });
});

describe("annotations store", () => {
  it("drops a box's scores when a person reshapes or relabels it", () => {
    const { update } = useAnnotations.getState();
    update("unsure", { geometry: { kind: "bbox", x: 5, y: 5, w: 10, h: 10 } });
    update("hidden", { classId: "c2" });
    update("clear", { zOrder: 3 });
    const { byId } = useAnnotations.getState();
    expect(byId.unsure.confidence).toBeNull();
    expect(byId.hidden.visible).toBeNull();
    // Restacking is not a correction: the scores stay.
    expect(byId.clear.confidence).toBe(0.9);
    // And the reshaped box no longer falls under any threshold.
    expect(passesScoreThresholds(byId.unsure, { minConfidence: 0.99, minVisible: 100 })).toBe(true);
  });
});

describe("LogoAiFilter review", () => {
  it("shows only the low-scored boxes instead of removing anything", async () => {
    renderFilter();
    fireEvent.click(screen.getByTestId("logo-ai-filter-open"));
    // Counted on the server for the review value, 0.90 by default.
    await waitFor(() =>
      expect(api.filterPreview).toHaveBeenCalledWith("t1", { min_confidence: 0.9, min_visible: 0 }),
    );
    const count = await screen.findByTestId("logo-ai-review-count");
    await waitFor(() => expect(count.textContent).toBe("35 of 120 boxes, on 9 images"));

    fireEvent.click(screen.getByTestId("logo-ai-review-start"));
    // The editor's own filter does the work: scored boxes under 0.90.
    const filter = useFilter.getState().filter as FilterGroup;
    expect(filter).toEqual({
      combinator: "AND",
      rules: [{ not: false, field: "confidence", op: "<", value: 0.9 }],
    });
    const shown = BOXES.filter((b) => evaluateFilter(b, {}, filter)).map((b) => b.tempId);
    expect(shown).toEqual(["edge", "unsure", "accepted"]);  // not the 0.90s, not the hand-drawn one
    expect(api.filterApply).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith(
      expect.stringContaining("scored under 0.90"),
      expect.anything(),
    );

    // Reopened while reviewing: it says so and offers the way out.
    fireEvent.click(screen.getByTestId("logo-ai-filter-open"));
    fireEvent.click(await screen.findByTestId("logo-ai-review-stop"));
    expect(useFilter.getState().filter).toBeNull();
  });
});
