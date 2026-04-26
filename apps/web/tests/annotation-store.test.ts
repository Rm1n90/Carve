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
