// Armin Mehri — mehri.armin@gmail.com
//
// CVAT-style floating paste. Ctrl+V no longer pastes instantly; it arms a
// placement mode where a ghost of the copied bbox(es) follows the cursor and
// a left-click commits them at the pointer, carrying their class. These tests
// cover the pure geometry helper (`placeClipboardEntries`), the store commit
// (`pastePlacedCentered`), and the tool-store arming state.
import { describe, expect, it, beforeEach } from "vitest";
import {
  useAnnotations,
  placeClipboardEntries,
  type ClipboardEntry,
} from "@/state/annotations";
import { useTool } from "@/state/tool";

function bboxEntry(
  x: number,
  y: number,
  w: number,
  h: number,
  classId = "c-1",
): ClipboardEntry {
  return {
    geometry: { kind: "bbox", x, y, w, h },
    classId,
    kind: "bbox",
    colorOverride: null,
  };
}

describe("placeClipboardEntries — floating-paste geometry", () => {
  it("centers a single bbox on the cursor", () => {
    const placed = placeClipboardEntries(
      [bboxEntry(0, 0, 10, 20)],
      { x: 100, y: 100 },
    );
    expect(placed).toHaveLength(1);
    const g = placed[0].geometry;
    expect(g.kind).toBe("bbox");
    if (g.kind === "bbox") {
      // top-left = cursor - half-size → (100-5, 100-10)
      expect(g.x).toBe(95);
      expect(g.y).toBe(90);
      expect(g.w).toBe(10);
      expect(g.h).toBe(20);
    }
  });

  it("preserves classId and colorOverride", () => {
    const placed = placeClipboardEntries(
      [{ ...bboxEntry(0, 0, 4, 4, "c-7"), colorOverride: "#abcdef" }],
      { x: 50, y: 50 },
    );
    expect(placed[0].classId).toBe("c-7");
    expect(placed[0].colorOverride).toBe("#abcdef");
    expect(placed[0].kind).toBe("bbox");
  });

  it("preserves relative layout when centering a group of boxes", () => {
    // group bbox is [0,0]-[30,10], center (15,5); cursor at (100,100)
    const placed = placeClipboardEntries(
      [bboxEntry(0, 0, 10, 10, "c-1"), bboxEntry(20, 0, 10, 10, "c-2")],
      { x: 100, y: 100 },
    );
    const ga = placed[0].geometry;
    const gb = placed[1].geometry;
    if (ga.kind === "bbox" && gb.kind === "bbox") {
      // dx = 100-15 = 85, dy = 100-5 = 95
      expect(ga.x).toBe(85);
      expect(ga.y).toBe(95);
      expect(gb.x).toBe(105);
      expect(gb.y).toBe(95);
      // relative spacing is preserved
      expect(gb.x - ga.x).toBe(20);
    }
  });

  it("clamps the placed bbox inside the image bounds", () => {
    const placed = placeClipboardEntries(
      [bboxEntry(0, 0, 40, 40)],
      { x: 1000, y: 1000 },
      { w: 100, h: 100 },
    );
    const g = placed[0].geometry;
    if (g.kind === "bbox") {
      expect(g.x).toBe(60); // 100 - 40
      expect(g.y).toBe(60);
    }
  });
});

describe("pastePlacedCentered — store commit", () => {
  beforeEach(() => {
    // Hard reset: reset([]) intentionally preserves dirty local drafts
    // (so unsaved edits survive asset switches), which would leak pasted
    // drafts between tests. setState guarantees a clean slate.
    useAnnotations.setState({
      byId: {},
      selectedId: null,
      selectedIds: [],
      pendingDeletes: [],
      history: { past: [], future: [] },
      lastEditMeta: null,
    });
  });

  it("inserts the pasted bbox centered on the cursor and selects it", () => {
    const id = useAnnotations
      .getState()
      .pastePlacedCentered(100, 100, [bboxEntry(0, 0, 10, 20)], "f-1");
    expect(id).not.toBeNull();
    const s = useAnnotations.getState();
    expect(s.selectedId).toBe(id);
    const draft = s.byId[id as string];
    expect(draft.classId).toBe("c-1");
    expect(draft.dirty).toBe(true);
    expect(draft.frameId).toBe("f-1");
    const g = draft.geometry;
    if (g.kind === "bbox") {
      expect(g.x).toBe(95);
      expect(g.y).toBe(90);
    }
  });

  it("returns null and inserts nothing when there are no entries", () => {
    const before = Object.keys(useAnnotations.getState().byId).length;
    const id = useAnnotations.getState().pastePlacedCentered(10, 10, []);
    expect(id).toBeNull();
    expect(Object.keys(useAnnotations.getState().byId)).toHaveLength(before);
  });

  it("drops a degenerate (<3-vertex) polygon entry instead of inserting it", () => {
    const id = useAnnotations.getState().pastePlacedCentered(50, 50, [
      {
        geometry: { kind: "polygon", points: [[0, 0], [10, 0]] },
        classId: "c-1",
        kind: "polygon",
        colorOverride: null,
      },
    ]);
    expect(id).toBeNull();
    expect(Object.keys(useAnnotations.getState().byId)).toHaveLength(0);
  });

  it("commits a multi-entry paste as a single undo step", () => {
    useAnnotations
      .getState()
      .pastePlacedCentered(100, 100, [
        bboxEntry(0, 0, 10, 10),
        bboxEntry(20, 0, 10, 10),
      ]);
    expect(Object.keys(useAnnotations.getState().byId)).toHaveLength(2);
    useAnnotations.getState().undo();
    expect(Object.keys(useAnnotations.getState().byId)).toHaveLength(0);
  });
});

describe("useTool — paste placement arming", () => {
  beforeEach(() => {
    useTool.getState().cancelPastePlacement();
    useTool.getState().setActive("cursor");
  });

  it("startPastePlacement arms and cancelPastePlacement clears", () => {
    expect(useTool.getState().pastePlacement).toBeNull();
    useTool.getState().startPastePlacement([bboxEntry(0, 0, 5, 5)]);
    expect(useTool.getState().pastePlacement).toHaveLength(1);
    useTool.getState().cancelPastePlacement();
    expect(useTool.getState().pastePlacement).toBeNull();
  });

  it("switching tools cancels an armed placement", () => {
    useTool.getState().startPastePlacement([bboxEntry(0, 0, 5, 5)]);
    expect(useTool.getState().pastePlacement).not.toBeNull();
    useTool.getState().setActive("bbox");
    expect(useTool.getState().pastePlacement).toBeNull();
  });
});
