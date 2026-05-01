/**
 * Plan-09 Phase 5 Task 13 — undo grouping.
 *
 * Contiguous edits to the SAME annotation within UNDO_GROUP_WINDOW_MS
 * collapse into one undo step. Selection moves, non-update ops, and a
 * gap longer than the window all flush the grouping state.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  UNDO_GROUP_WINDOW_MS,
  useAnnotations,
  type AnnotationDraft,
} from "@/state/annotations";

function makeDraft(tempId: string, x: number): AnnotationDraft {
  return {
    tempId,
    classId: "c-1",
    kind: "bbox",
    geometry: { kind: "bbox", x, y: 0, w: 10, h: 10 },
    frameId: "f-1",
    serverId: null,
    dirty: true,
  };
}

describe("undo grouping (plan-09 task-13)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 1, 0, 0, 0));
    useAnnotations.getState().reset([]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("collapses 5 rapid updates within the window into ONE undo step", () => {
    useAnnotations.getState().add(makeDraft("t-1", 0));
    const baseline = useAnnotations.getState().history.past.length;
    for (let i = 1; i <= 5; i++) {
      vi.advanceTimersByTime(50); // 5 * 50 = 250ms < 800ms
      useAnnotations.getState().update("t-1", {
        geometry: { kind: "bbox", x: i, y: 0, w: 10, h: 10 },
      });
    }
    const after = useAnnotations.getState().history.past.length;
    expect(after - baseline).toBe(1);
  });

  it("splits 5 rapid updates across two annotations into 2 undo steps", () => {
    useAnnotations.getState().add(makeDraft("t-1", 0));
    useAnnotations.getState().add(makeDraft("t-2", 100));
    const baseline = useAnnotations.getState().history.past.length;

    // 3 rapid updates to t-1, then 2 rapid updates to t-2 — different
    // targetId → second run starts a fresh undo entry.
    for (let i = 1; i <= 3; i++) {
      vi.advanceTimersByTime(50);
      useAnnotations.getState().update("t-1", {
        geometry: { kind: "bbox", x: i, y: 0, w: 10, h: 10 },
      });
    }
    for (let i = 1; i <= 2; i++) {
      vi.advanceTimersByTime(50);
      useAnnotations.getState().update("t-2", {
        geometry: { kind: "bbox", x: 100 + i, y: 0, w: 10, h: 10 },
      });
    }
    const after = useAnnotations.getState().history.past.length;
    expect(after - baseline).toBe(2);
  });

  it("treats a 1500ms gap as a fresh undo entry (2 steps)", () => {
    useAnnotations.getState().add(makeDraft("t-1", 0));
    const baseline = useAnnotations.getState().history.past.length;

    useAnnotations.getState().update("t-1", {
      geometry: { kind: "bbox", x: 1, y: 0, w: 10, h: 10 },
    });
    vi.advanceTimersByTime(UNDO_GROUP_WINDOW_MS + 700); // 1500ms total
    useAnnotations.getState().update("t-1", {
      geometry: { kind: "bbox", x: 2, y: 0, w: 10, h: 10 },
    });
    const after = useAnnotations.getState().history.past.length;
    expect(after - baseline).toBe(2);
  });

  it("an add() between updates flushes the grouping window (3 steps)", () => {
    useAnnotations.getState().add(makeDraft("t-1", 0));
    const baseline = useAnnotations.getState().history.past.length;

    useAnnotations.getState().update("t-1", {
      geometry: { kind: "bbox", x: 1, y: 0, w: 10, h: 10 },
    });
    vi.advanceTimersByTime(50);
    // Non-update op flushes meta — the next update on t-1 must start a
    // fresh undo entry even though it's well within the 800ms window.
    useAnnotations.getState().add(makeDraft("t-2", 100));
    vi.advanceTimersByTime(50);
    useAnnotations.getState().update("t-1", {
      geometry: { kind: "bbox", x: 2, y: 0, w: 10, h: 10 },
    });
    const after = useAnnotations.getState().history.past.length;
    // baseline + 1 (first update) + 1 (add) + 1 (post-add update).
    expect(after - baseline).toBe(3);
  });

  it("a select() between updates flushes the grouping window", () => {
    useAnnotations.getState().add(makeDraft("t-1", 0));
    useAnnotations.getState().add(makeDraft("t-2", 100));
    useAnnotations.getState().select("t-1");
    const baseline = useAnnotations.getState().history.past.length;

    useAnnotations.getState().update("t-1", {
      geometry: { kind: "bbox", x: 1, y: 0, w: 10, h: 10 },
    });
    vi.advanceTimersByTime(50);
    useAnnotations.getState().select("t-2");
    vi.advanceTimersByTime(50);
    useAnnotations.getState().select("t-1");
    vi.advanceTimersByTime(50);
    useAnnotations.getState().update("t-1", {
      geometry: { kind: "bbox", x: 2, y: 0, w: 10, h: 10 },
    });
    const after = useAnnotations.getState().history.past.length;
    expect(after - baseline).toBe(2);
  });

  it("undo after a grouped run reverts to the pre-run state in one step", () => {
    useAnnotations.getState().add(makeDraft("t-1", 0));
    for (let i = 1; i <= 5; i++) {
      vi.advanceTimersByTime(50);
      useAnnotations.getState().update("t-1", {
        geometry: { kind: "bbox", x: i, y: 0, w: 10, h: 10 },
      });
    }
    expect(
      (useAnnotations.getState().byId["t-1"].geometry as { x: number }).x,
    ).toBe(5);
    useAnnotations.getState().undo();
    expect(
      (useAnnotations.getState().byId["t-1"].geometry as { x: number }).x,
    ).toBe(0);
  });
});
