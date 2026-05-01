/**
 * Plan-09b Task 4 — Reviewer-name resolver tests.
 *
 * Renders ``<ReviewPanel>`` with a synthetic resolver and asserts that:
 *  - Rows whose ``reviewedById`` resolves to a name show ``<name> · <time>``.
 *  - Rows with an unknown reviewer id show only the time (no name prefix).
 *
 * This is a unit-level test for the meta-row rendering branch — the
 * ``AnnotateAssetPage`` integration (``useUsers`` + ``useMemo`` resolver) is
 * exercised by the existing annotate-page smoke tests at the integration
 * layer.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

import { ReviewPanel } from "@/components/annotation/ReviewPanel";
import { useAnnotations, type AnnotationDraft } from "@/state/annotations";
import { ConfirmProvider } from "@/components/ui/ConfirmDialog";

// Avoid network in case anything pulls in the api module.
vi.mock("@/api/annotations", async () => ({
  annotationsApi: { review: vi.fn(), batchReview: vi.fn() },
}));

const CLASSES = [{ id: "c-cat", idx: 0, name: "Cat", color: "#ff8800" }];

function bbox() {
  return { kind: "bbox" as const, x: 0, y: 0, w: 10, h: 10 };
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

function renderPanel(resolver: (id: string) => string | null) {
  return render(
    <ConfirmProvider>
      <ReviewPanel
        classes={CLASSES as unknown as import("@/api/classes").ClassRow[]}
        resolveReviewerName={resolver}
      />
    </ConfirmProvider>,
  );
}

beforeEach(() => {
  useAnnotations.getState().reset([]);
});

afterEach(() => {
  cleanup();
});

describe("ReviewPanel — reviewer-name resolver", () => {
  it("renders '<name> · <time>' when the resolver returns a name", () => {
    useAnnotations.getState().reset([
      makeDraft("a-known", {
        reviewedById: "u1",
        reviewedAt: new Date(Date.now() - 60_000).toISOString(),
      }),
    ]);
    renderPanel((id) => (id === "u1" ? "Alice" : null));

    fireEvent.click(screen.getByTestId("review-filter-all"));

    const meta = screen.getByTestId("review-row-meta-a-known");
    expect(meta.textContent).toContain("Alice");
    expect(meta.textContent).toMatch(/Alice\s*·/);
  });

  it("renders only the time (no name) when the resolver returns null", () => {
    useAnnotations.getState().reset([
      makeDraft("a-unknown", {
        reviewedById: "u-mystery",
        reviewedAt: new Date(Date.now() - 60_000).toISOString(),
      }),
    ]);
    renderPanel((id) => (id === "u1" ? "Alice" : null));

    fireEvent.click(screen.getByTestId("review-filter-all"));

    const meta = screen.getByTestId("review-row-meta-a-unknown");
    expect(meta.textContent).not.toContain("Alice");
    expect(meta.textContent).not.toContain(" · ");
    const row = screen.getByTestId("review-row-a-unknown");
    expect(within(row).getByTestId("review-row-meta-a-unknown")).toBe(meta);
  });

  it("renders only the time when reviewedById is null", () => {
    useAnnotations.getState().reset([
      makeDraft("a-no-reviewer", {
        reviewedById: null,
        reviewedAt: new Date(Date.now() - 60_000).toISOString(),
      }),
    ]);
    renderPanel((id) => (id === "u1" ? "Alice" : null));

    fireEvent.click(screen.getByTestId("review-filter-all"));

    const meta = screen.getByTestId("review-row-meta-a-no-reviewer");
    expect(meta.textContent).not.toContain("Alice");
    expect(meta.textContent).not.toContain(" · ");
  });
});
