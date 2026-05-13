// Armin Mehri — mehri.armin@gmail.com
//
// Regression coverage for undo/redo across save boundaries.
//
// Scenarios reproduced from user reports:
//   - "I draw plenty bboxes and then do undo, add new bbox and all of
//     them appear suddenly" — multi-undo dropped staged deletes; the
//     refetch re-hydrated server rows the undo had locally removed.
//   - "save Failed it happen when I play with undo and redo" — undo
//     restored entries with ghost serverIds (rows already deleted from
//     the server), so the next batch tried to UPDATE non-existent rows
//     and the API returned 404, failing the entire save.
import { describe, it, expect, beforeEach } from "vitest";
import { useAnnotations } from "../src/state/annotations";

function bbox(
  tempId: string,
  serverId: string | null,
  dirty: boolean,
  x = 0,
) {
  return {
    tempId,
    classId: "c-1",
    kind: "bbox" as const,
    geometry: { kind: "bbox" as const, x, y: 0, w: 10, h: 10 },
    frameId: null,
    serverId,
    dirty,
  };
}

describe("undo/redo across save boundaries", () => {
  beforeEach(() => {
    useAnnotations.getState().reset([]);
    useAnnotations.setState({
      history: { past: [], future: [] },
      lastEditMeta: null,
      pendingDeletes: [],
    });
  });

  it("multiple undos accumulate staged deletes (no S_E loss)", () => {
    const s = useAnnotations.getState();
    s.add(bbox("t-A", null, true, 0));
    s.add(bbox("t-B", null, true, 1));
    s.add(bbox("t-C", null, true, 2));
    s.add(bbox("t-D", null, true, 3));
    s.add(bbox("t-E", null, true, 4));
    s.markPersisted("t-A", "S_A");
    s.markPersisted("t-B", "S_B");
    s.markPersisted("t-C", "S_C");
    s.markPersisted("t-D", "S_D");
    s.markPersisted("t-E", "S_E");

    s.undo();
    s.undo();
    s.undo();
    s.undo();
    s.undo();

    const final = useAnnotations.getState();
    expect(Object.keys(final.byId)).toEqual([]);
    expect(new Set(final.pendingDeletes)).toEqual(
      new Set(["S_A", "S_B", "S_C", "S_D", "S_E"]),
    );
  });

  it("undo after save-deletion re-creates the row (no ghost UPDATE)", () => {
    const s = useAnnotations.getState();
    s.reset([bbox("t-A", "S_A", false)]);

    s.remove("t-A");
    expect(useAnnotations.getState().pendingDeletes).toEqual(["S_A"]);
    s.clearPendingDeletes();
    expect(useAnnotations.getState().pendingDeletes).toEqual([]);

    s.undo();
    const after = useAnnotations.getState();
    const restored = after.byId["t-A"];
    expect(restored).toBeDefined();
    expect(restored.serverId).toBeNull();
    expect(restored.dirty).toBe(true);
    expect(after.pendingDeletes).toEqual([]);
  });

  it("undo of geometry edit stages a dirty update (survives refetch)", () => {
    const s = useAnnotations.getState();
    s.reset([bbox("t-A", "S_A", false, 0)]);
    s.update("t-A", {
      geometry: { kind: "bbox", x: 50, y: 0, w: 10, h: 10 },
    });
    useAnnotations.setState((st) => ({
      byId: { ...st.byId, "t-A": { ...st.byId["t-A"], dirty: false } },
    }));

    s.undo();
    const after = useAnnotations.getState();
    const restored = after.byId["t-A"];
    expect(restored.dirty).toBe(true);
    expect(restored.serverId).toBe("S_A");
    expect((restored.geometry as { x: number }).x).toBe(0);
  });

  it("undo of pure additive change leaves untouched entries clean", () => {
    const s = useAnnotations.getState();
    s.reset([bbox("t-A", "S_A", false, 0)]);
    s.add(bbox("t-B", null, true, 50));
    s.markPersisted("t-B", "S_B");

    s.undo();
    const after = useAnnotations.getState();
    expect(after.byId["t-A"].dirty).toBe(false);
    expect(after.byId["t-B"]).toBeUndefined();
    expect(after.pendingDeletes).toEqual(["S_B"]);
  });

  it("undo of delete un-stages the pendingDelete (no double delete)", () => {
    const s = useAnnotations.getState();
    s.reset([bbox("t-A", "S_A", false)]);
    s.remove("t-A");
    expect(useAnnotations.getState().pendingDeletes).toEqual(["S_A"]);

    s.undo();
    const after = useAnnotations.getState();
    expect(after.byId["t-A"]).toBeDefined();
    expect(after.byId["t-A"].serverId).toBe("S_A");
    expect(after.pendingDeletes).toEqual([]);
  });

  it("redo of save-and-deleted entry stages a fresh delete", () => {
    const s = useAnnotations.getState();
    s.reset([bbox("t-A", "S_A", false)]);
    s.remove("t-A");
    s.clearPendingDeletes();

    s.undo();
    useAnnotations.setState((st) => ({
      byId: {
        ...st.byId,
        "t-A": { ...st.byId["t-A"], serverId: "S_A_new", dirty: false },
      },
    }));

    s.redo();
    const after = useAnnotations.getState();
    expect(after.byId["t-A"]).toBeUndefined();
    expect(after.pendingDeletes).toEqual(["S_A_new"]);
  });
});
