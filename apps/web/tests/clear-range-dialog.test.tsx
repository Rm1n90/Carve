// Armin Mehri — mehri.armin@gmail.com
//
// Verifies the "Clear annotations in a range" dialog:
//   - The Clear button stays disabled until BOTH endpoints are typed
//     (a blank field must never expand to the whole task).
//   - Clearing a 1-based asset position range sends a single batch
//     delete containing ONLY the annotations whose asset_id falls
//     inside the resolved range — assets outside the span are untouched.
//   - Unsaved local drafts (dirtyCount > 0) block the clear entirely.
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

import { ClearRangeDialog } from "@/components/annotation/ClearRangeDialog";
import { annotationsApi, type AnnotationRaw } from "@/api/annotations";

function rawAnn(id: string, assetId: string): AnnotationRaw {
  return {
    id,
    asset_id: assetId,
    frame_id: null,
    class_id: "cls-1",
    kind: "bbox",
    geometry: { kind: "bbox", x: 0, y: 0, w: 10, h: 10 },
    created_at: "2026-05-17T15:00:00Z",
    status: "proposed",
  };
}

// Five assets in canonical order; one annotation per asset.
const ORDERED = ["a1", "a2", "a3", "a4", "a5"];
const ALL_ANNS = ORDERED.map((aid, i) => rawAnn(`ann-${i + 1}`, aid));

describe("ClearRangeDialog", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => cleanup());

  it("keeps Clear disabled until both From and To are typed", () => {
    render(
      <ClearRangeDialog
        open
        onOpenChange={() => {}}
        taskId="task-1"
        orderedAssetIds={ORDERED}
        dirtyCount={0}
        onCleared={() => {}}
      />,
    );
    const clearBtn = screen.getByTestId("clear-range-confirm");
    expect(clearBtn).toBeDisabled();

    fireEvent.change(screen.getByTestId("clear-range-from"), {
      target: { value: "2" },
    });
    // Only one endpoint typed — still disabled.
    expect(clearBtn).toBeDisabled();

    fireEvent.change(screen.getByTestId("clear-range-to"), {
      target: { value: "4" },
    });
    expect(clearBtn).not.toBeDisabled();
  });

  it("batch-deletes only the annotations on assets inside the range", async () => {
    const listSpy = vi
      .spyOn(annotationsApi, "listForTaskRaw")
      .mockResolvedValue(ALL_ANNS);
    const batchSpy = vi
      .spyOn(annotationsApi, "batch")
      .mockResolvedValue({ created: [], updated: [], deleted: [] } as never);

    render(
      <ClearRangeDialog
        open
        onOpenChange={() => {}}
        taskId="task-1"
        orderedAssetIds={ORDERED}
        dirtyCount={0}
        onCleared={() => {}}
      />,
    );

    // Positions 2–4 (1-based) → assets a2, a3, a4 → ann-2, ann-3, ann-4.
    fireEvent.change(screen.getByTestId("clear-range-from"), {
      target: { value: "2" },
    });
    fireEvent.change(screen.getByTestId("clear-range-to"), {
      target: { value: "4" },
    });
    fireEvent.click(screen.getByTestId("clear-range-confirm"));

    await waitFor(() => expect(batchSpy).toHaveBeenCalledTimes(1));
    expect(listSpy).toHaveBeenCalledWith("task-1");
    expect(batchSpy).toHaveBeenCalledWith("task-1", {
      create: [],
      update: [],
      delete: ["ann-2", "ann-3", "ann-4"],
    });
  });

  it("refuses to clear while there are unsaved drafts", async () => {
    const batchSpy = vi.spyOn(annotationsApi, "batch");
    const listSpy = vi.spyOn(annotationsApi, "listForTaskRaw");

    render(
      <ClearRangeDialog
        open
        onOpenChange={() => {}}
        taskId="task-1"
        orderedAssetIds={ORDERED}
        dirtyCount={3}
        onCleared={() => {}}
      />,
    );
    fireEvent.change(screen.getByTestId("clear-range-from"), {
      target: { value: "1" },
    });
    fireEvent.change(screen.getByTestId("clear-range-to"), {
      target: { value: "5" },
    });
    fireEvent.click(screen.getByTestId("clear-range-confirm"));

    // Guard short-circuits before any network call.
    await Promise.resolve();
    expect(listSpy).not.toHaveBeenCalled();
    expect(batchSpy).not.toHaveBeenCalled();
  });
});
