import { describe, expect, it, beforeEach } from "vitest";
import { useAnnotations } from "@/state/annotations";

describe("annotation store", () => {
  beforeEach(() => {
    useAnnotations.getState().reset([]);
  });

  it("starts empty", () => {
    const s = useAnnotations.getState();
    expect(Object.keys(s.byId)).toHaveLength(0);
    expect(s.selectedId).toBeNull();
    expect(s.pendingDeletes).toEqual([]);
  });

  it("add stores draft and selects it", () => {
    useAnnotations.getState().add({
      tempId: "t-1", classId: "c-1", kind: "bbox",
      geometry: { kind: "bbox", x: 0, y: 0, w: 5, h: 5 },
      frameId: "f-1", serverId: null, dirty: true,
    });
    const s = useAnnotations.getState();
    expect(s.byId["t-1"]?.kind).toBe("bbox");
    expect(s.selectedId).toBe("t-1");
  });

  it("update marks draft dirty", () => {
    useAnnotations.getState().add({
      tempId: "t-1", classId: "c-1", kind: "bbox",
      geometry: { kind: "bbox", x: 0, y: 0, w: 5, h: 5 },
      frameId: null, serverId: "s-1", dirty: false,
    });
    useAnnotations.getState().update("t-1", {
      geometry: { kind: "bbox", x: 1, y: 1, w: 6, h: 6 },
    });
    expect(useAnnotations.getState().byId["t-1"].dirty).toBe(true);
    expect((useAnnotations.getState().byId["t-1"].geometry as any).w).toBe(6);
  });

  it("remove deletes draft and pushes serverId to pendingDeletes", () => {
    useAnnotations.getState().add({
      tempId: "t-1", classId: "c-1", kind: "bbox",
      geometry: { kind: "bbox", x: 0, y: 0, w: 5, h: 5 },
      frameId: null, serverId: "s-1", dirty: false,
    });
    useAnnotations.getState().remove("t-1");
    expect(useAnnotations.getState().byId["t-1"]).toBeUndefined();
    expect(useAnnotations.getState().pendingDeletes).toEqual(["s-1"]);
  });

  it("remove of unsaved draft does not pollute pendingDeletes", () => {
    useAnnotations.getState().add({
      tempId: "t-1", classId: "c-1", kind: "bbox",
      geometry: { kind: "bbox", x: 0, y: 0, w: 5, h: 5 },
      frameId: null, serverId: null, dirty: true,
    });
    useAnnotations.getState().remove("t-1");
    expect(useAnnotations.getState().pendingDeletes).toEqual([]);
  });

  it("reset replaces all drafts and clears pendingDeletes", () => {
    useAnnotations.getState().add({
      tempId: "t-1", classId: "c-1", kind: "bbox",
      geometry: { kind: "bbox", x: 0, y: 0, w: 5, h: 5 },
      frameId: null, serverId: "s-1", dirty: false,
    });
    useAnnotations.getState().remove("t-1");
    useAnnotations.getState().reset([
      { tempId: "t-2", classId: "c-1", kind: "polygon",
        geometry: { kind: "polygon", points: [[0, 0], [10, 0], [10, 10]] },
        frameId: null, serverId: "s-2", dirty: false },
    ]);
    const s = useAnnotations.getState();
    expect(Object.keys(s.byId)).toEqual(["t-2"]);
    expect(s.pendingDeletes).toEqual([]);
  });
});

describe("annotation store — multi-select & z-order", () => {
  beforeEach(() => {
    useAnnotations.getState().reset([]);
    useAnnotations.getState().add({
      tempId: "t-1", classId: "c-1", kind: "bbox",
      geometry: { kind: "bbox", x: 0, y: 0, w: 5, h: 5 },
      frameId: null, serverId: "s-1", dirty: false,
    });
    useAnnotations.getState().add({
      tempId: "t-2", classId: "c-1", kind: "bbox",
      geometry: { kind: "bbox", x: 10, y: 10, w: 5, h: 5 },
      frameId: null, serverId: "s-2", dirty: false,
    });
    useAnnotations.getState().add({
      tempId: "t-3", classId: "c-2", kind: "bbox",
      geometry: { kind: "bbox", x: 20, y: 20, w: 5, h: 5 },
      frameId: null, serverId: "s-3", dirty: false,
    });
  });

  it("toggleSelect adds a second id then removes it", () => {
    useAnnotations.getState().clearSelection();
    useAnnotations.getState().toggleSelect("t-1");
    useAnnotations.getState().toggleSelect("t-2");
    expect(useAnnotations.getState().selectedIds).toEqual(["t-1", "t-2"]);
    useAnnotations.getState().toggleSelect("t-1");
    expect(useAnnotations.getState().selectedIds).toEqual(["t-2"]);
  });

  it("selectMany replaces selection with given ids", () => {
    useAnnotations.getState().selectMany(["t-1", "t-3"]);
    expect(useAnnotations.getState().selectedIds).toEqual(["t-1", "t-3"]);
  });

  it("selectAll grabs every id with the same frameId", () => {
    useAnnotations.getState().selectAll(null);
    const ids = [...useAnnotations.getState().selectedIds].sort();
    expect(ids).toEqual(["t-1", "t-2", "t-3"]);
  });

  it("bringToFront raises zOrder above all peers", () => {
    useAnnotations.getState().bringToFront("t-1");
    const z1 = useAnnotations.getState().byId["t-1"].zOrder ?? 0;
    const z2 = useAnnotations.getState().byId["t-2"].zOrder ?? 0;
    expect(z1).toBeGreaterThan(z2);
  });

  it("sendToBack lowers zOrder below all peers", () => {
    useAnnotations.getState().sendToBack("t-2");
    const z1 = useAnnotations.getState().byId["t-1"].zOrder ?? 0;
    const z2 = useAnnotations.getState().byId["t-2"].zOrder ?? 0;
    expect(z2).toBeLessThan(z1);
  });

  it("bringForward bumps zOrder by 1", () => {
    const before = useAnnotations.getState().byId["t-1"].zOrder ?? 0;
    useAnnotations.getState().bringForward("t-1");
    const after = useAnnotations.getState().byId["t-1"].zOrder ?? 0;
    expect(after).toBe(before + 1);
  });

  it("sendBackward decreases zOrder by 1", () => {
    const before = useAnnotations.getState().byId["t-1"].zOrder ?? 0;
    useAnnotations.getState().sendBackward("t-1");
    const after = useAnnotations.getState().byId["t-1"].zOrder ?? 0;
    expect(after).toBe(before - 1);
  });

  it("undo restores prior state and redo replays it", () => {
    useAnnotations.getState().bringToFront("t-1");
    const promoted = useAnnotations.getState().byId["t-1"].zOrder ?? 0;
    useAnnotations.getState().undo();
    expect(useAnnotations.getState().byId["t-1"].zOrder ?? 0).not.toBe(promoted);
    useAnnotations.getState().redo();
    expect(useAnnotations.getState().byId["t-1"].zOrder ?? 0).toBe(promoted);
  });
});
