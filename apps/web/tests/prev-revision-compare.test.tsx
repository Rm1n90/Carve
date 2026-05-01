/**
 * Plan-09 Phase 5 Task 4 — prev-revision compare overlay.
 *
 * Covers:
 *  - hovering a row whose draft has ``prevGeometry`` adds the id to the
 *    review-compare bridge slice's ``hovered`` set; mouse-leave removes it,
 *  - clicking the row's "Show prev" toggle pins the id; clicking again
 *    unpins,
 *  - a pinned row's compare overlay survives a hover on a different row,
 *  - rows WITHOUT ``prevGeometry`` do not render the toggle button.
 */
import React from "react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { ReviewPanel } from "@/components/annotation/ReviewPanel";
import { useAnnotations, type AnnotationDraft } from "@/state/annotations";
import { useReviewCompare } from "@/state/reviewCompare";
import { ConfirmProvider } from "@/components/ui/ConfirmDialog";

// Mock the api module so the panel never hits the network even when
// other handlers fire incidentally.
vi.mock("@/api/annotations", () => ({
  annotationsApi: { review: vi.fn(), batchReview: vi.fn() },
}));

const CLASSES = [
  { id: "c-cat", idx: 0, name: "Cat", color: "#ff8800" } as const,
  { id: "c-dog", idx: 1, name: "Dog", color: "#0088ff" } as const,
];

function bbox(x = 0, y = 0, w = 10, h = 10) {
  return { kind: "bbox" as const, x, y, w, h };
}

function makeDraft(
  tempId: string,
  overrides: Partial<AnnotationDraft> = {},
): AnnotationDraft {
  return {
    tempId,
    classId: "c-cat",
    kind: "bbox",
    geometry: bbox(),
    frameId: null,
    serverId: tempId,
    dirty: false,
    status: "accepted",
    reviewedById: null,
    reviewedAt: null,
    prevGeometry: null,
    ...overrides,
  };
}

function renderPanel() {
  return render(
    <ConfirmProvider>
      <ReviewPanel
        classes={CLASSES as unknown as import("@/api/classes").ClassRow[]}
      />
    </ConfirmProvider>,
  );
}

beforeEach(() => {
  useAnnotations.getState().reset([]);
  useReviewCompare.getState().clear();
});

afterEach(() => {
  cleanup();
  document.body.removeAttribute("data-scroll-locked");
  document.body.removeAttribute("style");
});

describe("ReviewPanel — prev-revision compare hover", () => {
  it("mouse-enter on a row with prevGeometry adds the id to hovered; leave clears", () => {
    useAnnotations.getState().reset([
      makeDraft("a-1", {
        status: "accepted",
        prevGeometry: { kind: "bbox", x: 1, y: 2, w: 3, h: 4 },
      }),
    ]);
    renderPanel();
    fireEvent.click(screen.getByTestId("review-filter-all"));

    const row = screen.getByTestId("review-row-a-1");

    fireEvent.mouseEnter(row);
    expect(useReviewCompare.getState().hovered.has("a-1")).toBe(true);

    fireEvent.mouseLeave(row);
    expect(useReviewCompare.getState().hovered.has("a-1")).toBe(false);
  });

  it("rows WITHOUT prevGeometry do not show the Show-prev toggle", () => {
    useAnnotations.getState().reset([
      makeDraft("a-1", { status: "accepted", prevGeometry: null }),
    ]);
    renderPanel();
    fireEvent.click(screen.getByTestId("review-filter-all"));

    expect(screen.getByTestId("review-row-a-1")).toBeInTheDocument();
    expect(
      screen.queryByTestId("review-row-compare-a-1"),
    ).not.toBeInTheDocument();
  });
});

describe("ReviewPanel — prev-revision compare pin", () => {
  it("clicking 'Show prev' pins the id; clicking again unpins", () => {
    useAnnotations.getState().reset([
      makeDraft("a-1", {
        status: "accepted",
        prevGeometry: { kind: "bbox", x: 1, y: 2, w: 3, h: 4 },
      }),
    ]);
    renderPanel();
    fireEvent.click(screen.getByTestId("review-filter-all"));

    const toggle = screen.getByTestId("review-row-compare-a-1");

    fireEvent.click(toggle);
    expect(useReviewCompare.getState().pinned.has("a-1")).toBe(true);

    fireEvent.click(toggle);
    expect(useReviewCompare.getState().pinned.has("a-1")).toBe(false);
  });

  it("a pinned row's compare overlay survives a hover on a different row", () => {
    useAnnotations.getState().reset([
      makeDraft("a-1", {
        status: "accepted",
        prevGeometry: { kind: "bbox", x: 1, y: 2, w: 3, h: 4 },
      }),
      makeDraft("a-2", {
        status: "accepted",
        prevGeometry: {
          kind: "polygon",
          points: [
            [0, 0],
            [5, 0],
            [5, 5],
          ],
        },
      }),
    ]);
    renderPanel();
    fireEvent.click(screen.getByTestId("review-filter-all"));

    // Pin row 1.
    fireEvent.click(screen.getByTestId("review-row-compare-a-1"));
    expect(useReviewCompare.getState().pinned.has("a-1")).toBe(true);

    // Hover row 2 — pinned set is unchanged; hovered tracks row 2.
    fireEvent.mouseEnter(screen.getByTestId("review-row-a-2"));
    expect(useReviewCompare.getState().pinned.has("a-1")).toBe(true);
    expect(useReviewCompare.getState().hovered.has("a-2")).toBe(true);

    fireEvent.mouseLeave(screen.getByTestId("review-row-a-2"));
    expect(useReviewCompare.getState().pinned.has("a-1")).toBe(true);
    expect(useReviewCompare.getState().hovered.has("a-2")).toBe(false);
  });
});
