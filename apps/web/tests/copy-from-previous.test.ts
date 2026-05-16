/**
 * Tests for the copy-from-previous-asset pure helper.
 *
 * Pins:
 *   * fresh tempIds + dirty=true + serverId=null
 *   * review state is wiped (proposed / null / null / null)
 *   * trackId is wiped
 *   * bbox clamping to target image bounds + drop below MIN_BBOX_EDGE_PX
 *   * polygon clamping + adjacent-duplicate folding + first/last folding
 *     + drop below MIN_POLYGON_VERTICES
 *   * mask_rle is dropped when its raster size doesn't match the target
 *   * tag passes through
 *   * allowedClassIds filter
 *   * targetImageSize=null skips clamping but still enforces min-edge
 */
import { describe, expect, it } from "vitest";
import {
  copyAnnotationsToTarget,
  type CopySource,
  type ImageSize,
} from "@/lib/copy-from-previous";

function counter(): () => string {
  let n = 0;
  return () => `t-${++n}`;
}

const FIVE_BBOX: CopySource = {
  classId: "c-car",
  kind: "bbox",
  geometry: { kind: "bbox", x: 10, y: 10, w: 50, h: 30 },
};

const SIZE_100: ImageSize = { w: 100, h: 100 };

describe("copyAnnotationsToTarget — happy path", () => {
  it("emits fresh tempIds, dirty=true, serverId=null", () => {
    const r = copyAnnotationsToTarget([FIVE_BBOX], {
      targetImageSize: SIZE_100,
      allowedClassIds: null,
      targetFrameId: "frame-X",
      genTempId: counter(),
    });
    expect(r.accepted).toHaveLength(1);
    expect(r.accepted[0].tempId).toBe("t-1");
    expect(r.accepted[0].dirty).toBe(true);
    expect(r.accepted[0].serverId).toBeNull();
    expect(r.accepted[0].frameId).toBe("frame-X");
    expect(r.accepted[0].classId).toBe("c-car");
  });

  it("resets review state and trackId to a clean proposed baseline", () => {
    const source: CopySource = {
      ...FIVE_BBOX,
    };
    const r = copyAnnotationsToTarget([source], {
      targetImageSize: SIZE_100,
      allowedClassIds: null,
      targetFrameId: null,
      genTempId: counter(),
    });
    const a = r.accepted[0];
    expect(a.status).toBe("proposed");
    expect(a.reviewedById).toBeNull();
    expect(a.reviewedAt).toBeNull();
    expect(a.prevGeometry).toBeNull();
    expect(a.trackId).toBeNull();
  });

  it("preserves zOrder and colorOverride when present", () => {
    const r = copyAnnotationsToTarget(
      [{ ...FIVE_BBOX, zOrder: 7, colorOverride: "#abc" }],
      {
        targetImageSize: SIZE_100,
        allowedClassIds: null,
        targetFrameId: null,
        genTempId: counter(),
      },
    );
    expect(r.accepted[0].zOrder).toBe(7);
    expect(r.accepted[0].colorOverride).toBe("#abc");
  });
});

describe("copyAnnotationsToTarget — bbox clamping", () => {
  it("clamps a bbox that extends past the right edge", () => {
    const r = copyAnnotationsToTarget(
      [{ classId: "c", kind: "bbox", geometry: { kind: "bbox", x: 80, y: 10, w: 50, h: 30 } }],
      {
        targetImageSize: SIZE_100,
        allowedClassIds: null,
        targetFrameId: null,
        genTempId: counter(),
      },
    );
    expect(r.accepted).toHaveLength(1);
    const g = r.accepted[0].geometry;
    expect(g.kind).toBe("bbox");
    if (g.kind !== "bbox") throw new Error("type narrow");
    expect(g.x).toBe(80);
    expect(g.y).toBe(10);
    expect(g.w).toBe(20);
    expect(g.h).toBe(30);
  });

  it("drops a bbox that collapses below the minimum edge after clamping", () => {
    const r = copyAnnotationsToTarget(
      [
        { classId: "c", kind: "bbox", geometry: { kind: "bbox", x: 200, y: 10, w: 50, h: 30 } },
      ],
      {
        targetImageSize: SIZE_100,
        allowedClassIds: null,
        targetFrameId: null,
        genTempId: counter(),
      },
    );
    expect(r.accepted).toHaveLength(0);
    expect(r.skippedByGeometry).toBe(1);
  });

  it("drops a sub-MIN_BBOX_EDGE bbox even with no target size", () => {
    const r = copyAnnotationsToTarget(
      [{ classId: "c", kind: "bbox", geometry: { kind: "bbox", x: 0, y: 0, w: 2, h: 100 } }],
      {
        targetImageSize: null,
        allowedClassIds: null,
        targetFrameId: null,
        genTempId: counter(),
      },
    );
    expect(r.accepted).toHaveLength(0);
    expect(r.skippedByGeometry).toBe(1);
  });
});

describe("copyAnnotationsToTarget — polygon clamping", () => {
  it("clamps polygon vertices and dedupes adjacent duplicates", () => {
    const r = copyAnnotationsToTarget(
      [
        {
          classId: "c",
          kind: "polygon",
          geometry: {
            kind: "polygon",
            points: [
              [10, 10],
              [110, 10],
              [120, 10],
              [110, 90],
              [50, 50],
            ],
          },
        },
      ],
      {
        targetImageSize: SIZE_100,
        allowedClassIds: null,
        targetFrameId: null,
        genTempId: counter(),
      },
    );
    expect(r.accepted).toHaveLength(1);
    const g = r.accepted[0].geometry;
    if (g.kind !== "polygon") throw new Error("type narrow");
    expect(g.points).toEqual([
      [10, 10],
      [100, 10],
      [100, 90],
      [50, 50],
    ]);
  });

  it("folds the closing-vertex duplicate", () => {
    const r = copyAnnotationsToTarget(
      [
        {
          classId: "c",
          kind: "polygon",
          geometry: {
            kind: "polygon",
            points: [
              [10, 10],
              [50, 10],
              [50, 50],
              [10, 10],
            ],
          },
        },
      ],
      {
        targetImageSize: SIZE_100,
        allowedClassIds: null,
        targetFrameId: null,
        genTempId: counter(),
      },
    );
    const g = r.accepted[0].geometry;
    if (g.kind !== "polygon") throw new Error("type narrow");
    expect(g.points).toEqual([
      [10, 10],
      [50, 10],
      [50, 50],
    ]);
  });

  it("drops a polygon that collapses below 3 unique vertices", () => {
    const r = copyAnnotationsToTarget(
      [
        {
          classId: "c",
          kind: "polygon",
          // All three points fall in the same off-image corner so the
          // clamp collapses them onto a single (100, 100) vertex.
          geometry: { kind: "polygon", points: [[150, 120], [200, 130], [180, 110]] },
        },
      ],
      {
        targetImageSize: SIZE_100,
        allowedClassIds: null,
        targetFrameId: null,
        genTempId: counter(),
      },
    );
    expect(r.accepted).toHaveLength(0);
    expect(r.skippedByGeometry).toBe(1);
  });
});

describe("copyAnnotationsToTarget — mask & tag", () => {
  it("preserves mask_rle when raster size matches", () => {
    const r = copyAnnotationsToTarget(
      [
        {
          classId: "c",
          kind: "mask",
          geometry: { kind: "mask_rle", size: [100, 100], counts: "fake-rle" },
        },
      ],
      {
        targetImageSize: SIZE_100,
        allowedClassIds: null,
        targetFrameId: null,
        genTempId: counter(),
      },
    );
    expect(r.accepted).toHaveLength(1);
    expect(r.accepted[0].geometry.kind).toBe("mask_rle");
  });

  it("drops mask_rle when target image is a different size", () => {
    const r = copyAnnotationsToTarget(
      [
        {
          classId: "c",
          kind: "mask",
          geometry: { kind: "mask_rle", size: [100, 100], counts: "fake-rle" },
        },
      ],
      {
        targetImageSize: { w: 200, h: 100 },
        allowedClassIds: null,
        targetFrameId: null,
        genTempId: counter(),
      },
    );
    expect(r.accepted).toHaveLength(0);
    expect(r.skippedByGeometry).toBe(1);
  });

  it("copies tag annotations as-is (no spatial component)", () => {
    const r = copyAnnotationsToTarget(
      [{ classId: "weather-rain", kind: "tag", geometry: { kind: "tag" } }],
      {
        targetImageSize: SIZE_100,
        allowedClassIds: null,
        targetFrameId: "f-1",
        genTempId: counter(),
      },
    );
    expect(r.accepted).toHaveLength(1);
    expect(r.accepted[0].kind).toBe("tag");
    expect(r.accepted[0].frameId).toBe("f-1");
  });
});

describe("copyAnnotationsToTarget — class filtering", () => {
  it("drops sources whose class is not in allowedClassIds", () => {
    const r = copyAnnotationsToTarget(
      [
        FIVE_BBOX,
        { ...FIVE_BBOX, classId: "c-truck" },
        { ...FIVE_BBOX, classId: "c-bike" },
      ],
      {
        targetImageSize: SIZE_100,
        allowedClassIds: new Set(["c-car", "c-bike"]),
        targetFrameId: null,
        genTempId: counter(),
      },
    );
    expect(r.accepted.map((a) => a.classId)).toEqual(["c-car", "c-bike"]);
    expect(r.skippedByClass).toBe(1);
  });

  it("an empty allowedClassIds set drops everything", () => {
    const r = copyAnnotationsToTarget(
      [FIVE_BBOX, { ...FIVE_BBOX, classId: "c-truck" }],
      {
        targetImageSize: SIZE_100,
        allowedClassIds: new Set(),
        targetFrameId: null,
        genTempId: counter(),
      },
    );
    expect(r.accepted).toHaveLength(0);
    expect(r.skippedByClass).toBe(2);
  });

  it("null allowedClassIds accepts every class", () => {
    const r = copyAnnotationsToTarget(
      [FIVE_BBOX, { ...FIVE_BBOX, classId: "c-truck" }],
      {
        targetImageSize: SIZE_100,
        allowedClassIds: null,
        targetFrameId: null,
        genTempId: counter(),
      },
    );
    expect(r.accepted).toHaveLength(2);
    expect(r.skippedByClass).toBe(0);
  });
});

describe("copyAnnotationsToTarget — empty inputs", () => {
  it("handles an empty source list cleanly", () => {
    const r = copyAnnotationsToTarget([], {
      targetImageSize: SIZE_100,
      allowedClassIds: null,
      targetFrameId: null,
      genTempId: counter(),
    });
    expect(r.accepted).toEqual([]);
    expect(r.skippedByClass).toBe(0);
    expect(r.skippedByGeometry).toBe(0);
  });
});
