/**
 * F6 — snap-target helper tests.
 *
 * Pins:
 *   * vertex within threshold returns kind="vertex"
 *   * edge projection within threshold returns kind="edge"
 *   * vertex wins over an equidistant edge
 *   * out-of-threshold returns null
 *   * scale changes the effective image-space threshold
 *   * self-exclusion via excludeTempId + excludeVertices
 *   * hidden / class-hidden / wrong-frame annotations are skipped
 */
import { describe, expect, it } from "vitest";
import {
  findSnapTarget,
  type SnapFilter,
} from "@/lib/snap-target";
import type { AnnotationDraft, Geometry } from "@/state/annotations";

function bbox(
  tempId: string,
  classId: string,
  x: number,
  y: number,
  w: number,
  h: number,
  frameId: string | null = null,
): AnnotationDraft {
  return {
    tempId,
    classId,
    kind: "bbox",
    geometry: { kind: "bbox", x, y, w, h } as Geometry,
    frameId,
    serverId: null,
    dirty: false,
  };
}

const EMPTY_FILTER: SnapFilter = {
  frameId: null,
  hiddenAnnIds: new Set(),
  hiddenClassIds: new Set(),
  excludeTempId: null,
  excludeVertices: [],
};

describe("findSnapTarget — vertex snaps", () => {
  it("snaps to the nearest vertex within threshold", () => {
    const r = findSnapTarget({ x: 12, y: 11 }, 1, [bbox("a", "c", 10, 10, 20, 20)], EMPTY_FILTER);
    expect(r?.kind).toBe("vertex");
    expect(r?.x).toBe(10);
    expect(r?.y).toBe(10);
  });

  it("returns null when no candidate is within threshold", () => {
    const r = findSnapTarget({ x: 500, y: 500 }, 1, [bbox("a", "c", 10, 10, 20, 20)], EMPTY_FILTER);
    expect(r).toBeNull();
  });
});

describe("findSnapTarget — edge snaps", () => {
  it("snaps perpendicularly onto an edge when no vertex is closer", () => {
    const r = findSnapTarget({ x: 30, y: 13 }, 1, [bbox("a", "c", 10, 10, 40, 40)], EMPTY_FILTER);
    expect(r?.kind).toBe("edge");
    expect(r?.x).toBe(30);
    expect(r?.y).toBe(10);
  });

  it("clamps the projection at segment endpoints (no past-vertex snaps)", () => {
    // Cursor past the right end of the top edge of bbox(10,10,40,40).
    // Top edge runs from (10,10) → (50,10); right edge from (50,10)
    // → (50,50). At threshold=20 the cursor (60,12) is closest to the
    // right edge at (50,12), distance 10 — that's the snap point.
    // The corner (50,10) is sqrt(104)≈10.2 away, just beyond.
    const r = findSnapTarget({ x: 60, y: 12 }, 1, [bbox("a", "c", 10, 10, 40, 40)], EMPTY_FILTER);
    const r2 = findSnapTarget(
      { x: 60, y: 12 }, 1, [bbox("a", "c", 10, 10, 40, 40)], EMPTY_FILTER, 20,
    );
    expect(r).toBeNull();
    expect(r2?.kind).toBe("edge");
    expect(r2?.x).toBe(50);
    expect(r2?.y).toBe(12);
  });
});

describe("findSnapTarget — vertex beats edge at equal distance", () => {
  it("when vertex and edge are equidistant, vertex wins", () => {
    const r = findSnapTarget({ x: 10, y: 10 }, 1, [bbox("a", "c", 10, 10, 20, 20)], EMPTY_FILTER);
    expect(r?.kind).toBe("vertex");
  });
});

describe("findSnapTarget — scale + image-space threshold", () => {
  it("at 2x zoom the image-space threshold halves", () => {
    // Cursor 7 image-px from a corner along the diagonal — outside the
    // bbox so the edge isn't closer than the corner.
    //   @ scale=1 → effective threshold 8 image-px, vertex-prefer band
    //   3.2; the diagonal distance sqrt(98)≈9.9 is OUT of threshold so
    //   the snap returns null.
    //   We want a clear "snap then no-snap" pair: cursor (3, 0) is on
    //   the top edge at image-distance 0 → always snaps regardless of
    //   scale. Cursor (-7, 0) is past the top-left corner at distance
    //   7 from the corner. @scale=1 within threshold 8 → vertex (0,0)
    //   wins (vertex bias band 3.2 covers 7? no, 7 > 3.2 → fall to
    //   closest. Edge top from (0,0) to (100,0) projects to (-7,0)→
    //   clamps to (0,0). Equidistant; vertex wins.). @scale=2 the
    //   threshold drops to 4 image-px → 7 > 4 → null.
    const drafts = [bbox("a", "c", 0, 0, 100, 100)];
    expect(findSnapTarget({ x: -7, y: 0 }, 1, drafts, EMPTY_FILTER)?.kind).toBe("vertex");
    expect(findSnapTarget({ x: -7, y: 0 }, 2, drafts, EMPTY_FILTER)).toBeNull();
  });

  it("clamps the image-space threshold to SNAP_IMAGE_PX_MAX (24) at low zoom", () => {
    // Cursor INSIDE the box, equidistant 25px from all 4 edges (well,
    // 25 from top+left, 75 from bottom+right). At scale=0.1 the raw
    // threshold would be 80 image-px → unclamped this would snap. The
    // clamp pins it to 24, so 25 > 24 → null.
    const drafts = [bbox("a", "c", 0, 0, 100, 100)];
    expect(findSnapTarget({ x: 25, y: 25 }, 0.1, drafts, EMPTY_FILTER)).toBeNull();
  });
});

describe("findSnapTarget — self-exclusion", () => {
  it("excludes the annotation matching excludeTempId", () => {
    const r = findSnapTarget(
      { x: 11, y: 11 },
      1,
      [bbox("self", "c", 10, 10, 20, 20)],
      { ...EMPTY_FILTER, excludeTempId: "self" },
    );
    expect(r).toBeNull();
  });

  it("excludes explicit vertices passed in excludeVertices", () => {
    // The bbox has corners (10,10),(30,10),(30,30),(10,30). Excluding
    // (10,10) prevents the snap from picking that vertex specifically,
    // but EDGES that share that corner are still snap candidates. The
    // helper falls back to the closest edge — top edge projection at
    // (11, 10), distance 1. This is the desired behaviour for the
    // polygon tool: the user wants snapping to existing geometry to
    // keep working even on stale endpoints.
    const r = findSnapTarget(
      { x: 11, y: 11 },
      1,
      [bbox("a", "c", 10, 10, 20, 20)],
      { ...EMPTY_FILTER, excludeVertices: [[10, 10]] },
    );
    expect(r?.kind).toBe("edge");
    expect(r?.x).toBe(11);
    expect(r?.y).toBe(10);
  });

  it("excludeTempId removes ALL of the in-progress annotation (vertices + edges)", () => {
    // For the polygon self-snap case the cleaner approach is to
    // exclude the whole annotation by tempId; that way edges aren't
    // candidates either.
    const r = findSnapTarget(
      { x: 11, y: 11 },
      1,
      [bbox("self", "c", 10, 10, 20, 20)],
      { ...EMPTY_FILTER, excludeTempId: "self" },
    );
    expect(r).toBeNull();
  });
});

describe("findSnapTarget — visibility filters", () => {
  it("skips hidden annotations", () => {
    const r = findSnapTarget(
      { x: 11, y: 11 },
      1,
      [bbox("a", "c", 10, 10, 20, 20)],
      { ...EMPTY_FILTER, hiddenAnnIds: new Set(["a"]) },
    );
    expect(r).toBeNull();
  });
  it("skips hidden classes", () => {
    const r = findSnapTarget(
      { x: 11, y: 11 },
      1,
      [bbox("a", "car", 10, 10, 20, 20)],
      { ...EMPTY_FILTER, hiddenClassIds: new Set(["car"]) },
    );
    expect(r).toBeNull();
  });
  it("only considers candidates on the active frame", () => {
    const drafts = [
      bbox("a", "c", 10, 10, 20, 20, "frame-1"),
      bbox("b", "c", 100, 100, 20, 20, "frame-2"),
    ];
    const r = findSnapTarget({ x: 11, y: 11 }, 1, drafts, { ...EMPTY_FILTER, frameId: "frame-2" });
    expect(r).toBeNull();
  });
});

describe("findSnapTarget — polygon vertices", () => {
  it("snaps to a polygon vertex", () => {
    const drafts: AnnotationDraft[] = [
      {
        tempId: "p",
        classId: "c",
        kind: "polygon",
        geometry: { kind: "polygon", points: [[10, 10], [50, 10], [50, 50]] },
        frameId: null,
        serverId: null,
        dirty: false,
      },
    ];
    const r = findSnapTarget({ x: 50, y: 12 }, 1, drafts, EMPTY_FILTER);
    expect(r?.kind).toBe("vertex");
    expect(r?.x).toBe(50);
    expect(r?.y).toBe(10);
  });
});
