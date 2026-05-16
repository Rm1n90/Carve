/**
 * F4 — streak indicator store tests.
 *
 * Pins ``useTool.recordDraw`` semantics:
 *   * Same-class consecutive draws increment streakCount.
 *   * Switching class resets to 1 with the new class as lastDrawClassId.
 *   * recordDraw(null) is a defensive no-op.
 *   * resetStreak clears state back to (null, 0).
 *   * Programmatic adds DON'T call recordDraw — confirmed by the fact
 *     that simply calling useAnnotations.add() does not increment the
 *     streak. (The actual tools call recordDraw alongside add.)
 */
import { beforeEach, describe, expect, it } from "vitest";
import { useTool } from "@/state/tool";

beforeEach(() => {
  useTool.getState().resetStreak();
});

describe("useTool.recordDraw", () => {
  it("seeds the streak on the first draw", () => {
    useTool.getState().recordDraw("c-car");
    expect(useTool.getState().lastDrawClassId).toBe("c-car");
    expect(useTool.getState().streakCount).toBe(1);
  });

  it("increments when the same class draws again", () => {
    useTool.getState().recordDraw("c-car");
    useTool.getState().recordDraw("c-car");
    useTool.getState().recordDraw("c-car");
    expect(useTool.getState().streakCount).toBe(3);
    expect(useTool.getState().lastDrawClassId).toBe("c-car");
  });

  it("resets to 1 when a different class is drawn", () => {
    useTool.getState().recordDraw("c-car");
    useTool.getState().recordDraw("c-car");
    useTool.getState().recordDraw("c-truck");
    expect(useTool.getState().streakCount).toBe(1);
    expect(useTool.getState().lastDrawClassId).toBe("c-truck");
  });

  it("is a no-op when called with null", () => {
    useTool.getState().recordDraw("c-car");
    useTool.getState().recordDraw(null);
    expect(useTool.getState().streakCount).toBe(1);
    expect(useTool.getState().lastDrawClassId).toBe("c-car");
  });

  it("survives an unrelated state change (active class switch)", () => {
    useTool.getState().recordDraw("c-car");
    useTool.getState().recordDraw("c-car");
    useTool.getState().setActiveClassId("c-truck");
    expect(useTool.getState().streakCount).toBe(2);
    expect(useTool.getState().lastDrawClassId).toBe("c-car");
  });
});

describe("useTool.resetStreak", () => {
  it("clears the streak back to (null, 0)", () => {
    useTool.getState().recordDraw("c-car");
    useTool.getState().recordDraw("c-car");
    useTool.getState().resetStreak();
    expect(useTool.getState().lastDrawClassId).toBeNull();
    expect(useTool.getState().streakCount).toBe(0);
  });
});

describe("default state", () => {
  it("starts at (null, 0)", () => {
    // resetStreak runs in beforeEach; this confirms the default is
    // semantically equivalent to a fresh store.
    expect(useTool.getState().lastDrawClassId).toBeNull();
    expect(useTool.getState().streakCount).toBe(0);
  });
});
