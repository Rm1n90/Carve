/**
 * Plan-09 Phase 5 Task 3 — ReviewPanel tests.
 *
 * Covers:
 *  - filter pills narrow the visible list,
 *  - per-row Accept optimistic flip + API call,
 *  - API failure path reverts to ``proposed`` and toasts,
 *  - bulk accept opens the confirm dialog and calls ``batchReview``
 *    with the proposed ids on confirmation,
 *  - keyboard A / R drive the same review path on the single
 *    selected annotation.
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
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";

import { ReviewPanel } from "@/components/annotation/ReviewPanel";
import { useAnnotations, type AnnotationDraft } from "@/state/annotations";
import { ConfirmProvider } from "@/components/ui/ConfirmDialog";
import {
  _resetToastBusForTests,
  subscribeToasts,
  type ToastEvent,
} from "@/lib/toast";

// ---- Mock the api module so we never hit the network. -----------------
vi.mock("@/api/annotations", async () => {
  const review = vi.fn();
  const batchReview = vi.fn();
  return {
    annotationsApi: { review, batchReview },
  };
});

// Pull the mocked fns back out so individual tests can program them.
import { annotationsApi } from "@/api/annotations";
const reviewMock = annotationsApi.review as unknown as ReturnType<typeof vi.fn>;
const batchReviewMock = annotationsApi.batchReview as unknown as ReturnType<
  typeof vi.fn
>;

// ---- Fixtures ---------------------------------------------------------
const CLASSES = [
  { id: "c-cat", idx: 0, name: "Cat", color: "#ff8800" } as const,
  { id: "c-dog", idx: 1, name: "Dog", color: "#0088ff" } as const,
];

function bbox(x = 0, y = 0, w = 10, h = 10) {
  return { kind: "bbox" as const, x, y, w, h };
}

function makeDraft(
  tempId: string,
  status: "proposed" | "accepted" | "rejected",
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
    status,
    reviewedById: null,
    reviewedAt: null,
    prevGeometry: null,
    ...overrides,
  };
}

function seedThree() {
  useAnnotations.getState().reset([
    makeDraft("a-1", "proposed"),
    makeDraft("a-2", "accepted", {
      reviewedById: "u-1",
      reviewedAt: new Date(Date.now() - 60_000).toISOString(),
    }),
    makeDraft("a-3", "rejected"),
  ]);
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
  reviewMock.mockReset();
  batchReviewMock.mockReset();
  useAnnotations.getState().reset([]);
  _resetToastBusForTests();
});

afterEach(() => {
  cleanup();
  document.body.removeAttribute("data-scroll-locked");
  document.body.removeAttribute("style");
});

describe("ReviewPanel — filter pills", () => {
  it("default filter is Proposed and only shows proposed rows", () => {
    seedThree();
    renderPanel();
    expect(screen.getByTestId("review-row-a-1")).toBeInTheDocument();
    expect(screen.queryByTestId("review-row-a-2")).not.toBeInTheDocument();
    expect(screen.queryByTestId("review-row-a-3")).not.toBeInTheDocument();
  });

  it("All shows all three statuses; Rejected narrows to rejected only", () => {
    seedThree();
    renderPanel();
    fireEvent.click(screen.getByTestId("review-filter-all"));
    expect(screen.getByTestId("review-row-a-1")).toBeInTheDocument();
    expect(screen.getByTestId("review-row-a-2")).toBeInTheDocument();
    expect(screen.getByTestId("review-row-a-3")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("review-filter-rejected"));
    expect(screen.queryByTestId("review-row-a-1")).not.toBeInTheDocument();
    expect(screen.queryByTestId("review-row-a-2")).not.toBeInTheDocument();
    expect(screen.getByTestId("review-row-a-3")).toBeInTheDocument();
  });
});

describe("ReviewPanel — per-row Accept", () => {
  it("optimistically flips status to accepted and calls api.review", async () => {
    seedThree();
    reviewMock.mockResolvedValue({
      ...makeDraft("a-1", "accepted"),
      reviewedById: "u-1",
      reviewedAt: "2026-05-01T00:00:00Z",
    });
    renderPanel();

    fireEvent.click(screen.getByTestId("review-row-accept-a-1"));

    // Optimistic flip happens synchronously in the store.
    expect(useAnnotations.getState().byId["a-1"].status).toBe("accepted");

    await waitFor(() => expect(reviewMock).toHaveBeenCalledTimes(1));
    expect(reviewMock).toHaveBeenCalledWith("a-1", "accept");

    // Server-authoritative fields applied after resolution.
    await waitFor(() => {
      const after = useAnnotations.getState().byId["a-1"];
      expect(after.reviewedById).toBe("u-1");
      expect(after.reviewedAt).toBe("2026-05-01T00:00:00Z");
    });
  });

  it("reverts to proposed and toasts when the API rejects", async () => {
    seedThree();
    const events: ToastEvent[] = [];
    subscribeToasts((e) => events.push(e));
    reviewMock.mockRejectedValue({
      response: { data: { detail: "boom" } },
    });
    renderPanel();

    fireEvent.click(screen.getByTestId("review-row-accept-a-1"));

    // Optimistic flip first.
    expect(useAnnotations.getState().byId["a-1"].status).toBe("accepted");

    await waitFor(() => {
      expect(useAnnotations.getState().byId["a-1"].status).toBe("proposed");
    });
    expect(
      events.some((e) => e.variant === "error" && /boom/.test(e.message)),
    ).toBe(true);
  });
});

describe("ReviewPanel — bulk accept", () => {
  it("opens confirm dialog with the proposed count, then calls batchReview on confirm", async () => {
    useAnnotations.getState().reset([
      makeDraft("p-1", "proposed"),
      makeDraft("p-2", "proposed"),
      makeDraft("a-9", "accepted"),
    ]);
    batchReviewMock.mockResolvedValue({ reviewed: ["p-1", "p-2"], skipped: [] });
    renderPanel();

    fireEvent.click(screen.getByTestId("review-bulk-accept"));

    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText(/2 proposed/i)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByText(/Accept all/i));

    await waitFor(() => expect(batchReviewMock).toHaveBeenCalledTimes(1));
    const [ids, decision] = batchReviewMock.mock.calls[0];
    expect(new Set(ids)).toEqual(new Set(["p-1", "p-2"]));
    expect(decision).toBe("accept");

    await waitFor(() => {
      expect(useAnnotations.getState().byId["p-1"].status).toBe("accepted");
      expect(useAnnotations.getState().byId["p-2"].status).toBe("accepted");
    });
  });
});

describe("ReviewPanel — keyboard shortcuts", () => {
  it("A accepts and R rejects the single selected annotation", async () => {
    seedThree();
    useAnnotations.getState().select("a-1");
    reviewMock.mockResolvedValue(makeDraft("a-1", "accepted"));
    renderPanel();

    fireEvent.keyDown(window, { key: "a" });
    await waitFor(() =>
      expect(reviewMock).toHaveBeenCalledWith("a-1", "accept"),
    );

    useAnnotations.getState().select("a-1");
    reviewMock.mockResolvedValue(makeDraft("a-1", "rejected"));
    fireEvent.keyDown(window, { key: "r" });
    await waitFor(() =>
      expect(reviewMock).toHaveBeenLastCalledWith("a-1", "reject"),
    );
  });

  it("does not fire when typing into an input", async () => {
    seedThree();
    useAnnotations.getState().select("a-1");
    reviewMock.mockResolvedValue(makeDraft("a-1", "accepted"));
    renderPanel();

    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    fireEvent.keyDown(input, { key: "a" });
    await Promise.resolve();
    expect(reviewMock).not.toHaveBeenCalled();
    document.body.removeChild(input);
  });

  it("does not fire when more than one annotation is selected", async () => {
    seedThree();
    useAnnotations.getState().selectMany(["a-1", "a-2"]);
    reviewMock.mockResolvedValue(makeDraft("a-1", "accepted"));
    renderPanel();

    fireEvent.keyDown(window, { key: "a" });
    await Promise.resolve();
    expect(reviewMock).not.toHaveBeenCalled();
  });
});
