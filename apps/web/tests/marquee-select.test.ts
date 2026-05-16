/**
 * F5 — marquee selection helper tests.
 *
 * Pins:
 *   * normaliseRect handles reversed drags
 *   * rectIntersects: edges-touch counts; clear miss returns false
 *   * geometryAabb: bbox/polygon/mask shapes, tag returns null
 *   * marqueeHits respects hiddenAnnIds, hiddenClassIds, frameId
 *   * applyMarqueeMutation: replace, add (no dupes), remove
 */
import { describe, expect, it } from "vitest";
import {
  applyMarqueeMutation,
  geometryAabb,
  marqueeHits,
  normaliseRect,
  rectIntersects,
  type MarqueeFilter,
} from "@/lib/marquee-select";
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

const NO_FILTER: MarqueeFilter = {
  hiddenAnnIds: new Set(),
  hiddenClassIds: new Set(),
  frameId: null,
};

describe("normaliseRect", () => {
  it("normalises a forward drag", () => {
    expect(normaliseRect({ x: 10, y: 20 }, { x: 50, y: 80 })).toEqual({
      x1: 10, y1: 20, x2: 50, y2: 80,
    });
  });
  it("normalises a reversed drag (bottom-right to top-left)", () => {
    expect(normaliseRect({ x: 50, y: 80 }, { x: 10, y: 20 })).toEqual({
      x1: 10, y1: 20, x2: 50, y2: 80,
    });
  });
});

describe("rectIntersects", () => {
  it("treats edge-touching as a hit", () => {
    expect(rectIntersects(
      { x1: 0, y1: 0, x2: 10, y2: 10 },
      { x1: 10, y1: 0, x2: 20, y2: 10 },
    )).toBe(true);
  });
  it("returns false for a clear miss", () => {
    expect(rectIntersects(
      { x1: 0, y1: 0, x2: 10, y2: 10 },
      { x1: 20, y1: 20, x2: 30, y2: 30 },
    )).toBe(false);
  });
});

describe("geometryAabb", () => {
  it("returns the bbox geometry as-is", () => {
    expect(geometryAabb({ kind: "bbox", x: 5, y: 5, w: 10, h: 20 })).toEqual({
      x1: 5, y1: 5, x2: 15, y2: 25,
    });
  });
  it("returns the polygon bounding box", () => {
    expect(
      geometryAabb({ kind: "polygon", points: [[10, 0], [50, 30], [0, 20]] }),
    ).toEqual({ x1: 0, y1: 0, x2: 50, y2: 30 });
  });
  it("returns the mask raster bounds", () => {
    expect(
      geometryAabb({ kind: "mask_rle", size: [100, 200], counts: "x" }),
    ).toEqual({ x1: 0, y1: 0, x2: 200, y2: 100 });
  });
  it("returns null for tag (no spatial component)", () => {
    expect(geometryAabb({ kind: "tag" })).toBeNull();
  });
});

describe("marqueeHits — filtering", () => {
  it("picks every annotation whose AABB intersects the rect", () => {
    const drafts = [
      bbox("a", "c1", 0, 0, 10, 10),
      bbox("b", "c1", 100, 100, 10, 10),
      bbox("c", "c1", 5, 5, 10, 10),
    ];
    const hits = marqueeHits(
      { x1: 0, y1: 0, x2: 20, y2: 20 },
      drafts,
      NO_FILTER,
    );
    expect(new Set(hits)).toEqual(new Set(["a", "c"]));
  });

  it("skips hidden annotation ids", () => {
    const drafts = [bbox("a", "c1", 0, 0, 10, 10), bbox("b", "c1", 5, 5, 10, 10)];
    const hits = marqueeHits(
      { x1: 0, y1: 0, x2: 20, y2: 20 },
      drafts,
      { ...NO_FILTER, hiddenAnnIds: new Set(["b"]) },
    );
    expect(hits).toEqual(["a"]);
  });

  it("skips hidden class ids", () => {
    const drafts = [bbox("a", "car", 0, 0, 10, 10), bbox("b", "truck", 5, 5, 10, 10)];
    const hits = marqueeHits(
      { x1: 0, y1: 0, x2: 20, y2: 20 },
      drafts,
      { ...NO_FILTER, hiddenClassIds: new Set(["truck"]) },
    );
    expect(hits).toEqual(["a"]);
  });

  it("only considers annotations on the active frame", () => {
    const drafts = [
      bbox("a", "c", 0, 0, 10, 10, "frame-1"),
      bbox("b", "c", 5, 5, 10, 10, "frame-2"),
    ];
    expect(
      marqueeHits({ x1: 0, y1: 0, x2: 20, y2: 20 }, drafts, {
        ...NO_FILTER,
        frameId: "frame-1",
      }),
    ).toEqual(["a"]);
  });

  it("returns an empty array on no hits", () => {
    expect(
      marqueeHits({ x1: 1000, y1: 1000, x2: 1010, y2: 1010 }, [bbox("a", "c", 0, 0, 10, 10)], NO_FILTER),
    ).toEqual([]);
  });
});

describe("applyMarqueeMutation", () => {
  it("replace ignores prior selection", () => {
    expect(applyMarqueeMutation(["a", "b"], ["c", "d"], "replace")).toEqual(["c", "d"]);
  });
  it("add unions without duplicates", () => {
    expect(applyMarqueeMutation(["a", "b"], ["b", "c"], "add")).toEqual(["a", "b", "c"]);
  });
  it("remove subtracts hits from current", () => {
    expect(applyMarqueeMutation(["a", "b", "c"], ["b"], "remove")).toEqual(["a", "c"]);
  });
  it("add with no hits keeps current selection intact", () => {
    expect(applyMarqueeMutation(["a", "b"], [], "add")).toEqual(["a", "b"]);
  });
  it("replace with no hits clears the selection", () => {
    expect(applyMarqueeMutation(["a", "b"], [], "replace")).toEqual([]);
  });
});
