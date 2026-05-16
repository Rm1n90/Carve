/**
 * Tests for the annotation-health detectors.
 *
 * Pins every code's positive + negative case, the absent-image-bounds
 * skip behaviour, and the duplicate-class-iou cross-annotation pass.
 */
import { describe, expect, it } from "vitest";
import {
  computeAnnotationFlags,
  flagLabel,
  type ImageBounds,
} from "@/lib/annotation-health";
import type { AnnotationDraft, Geometry } from "@/state/annotations";

function bbox(
  tempId: string,
  classId: string,
  x: number,
  y: number,
  w: number,
  h: number,
): AnnotationDraft {
  return {
    tempId,
    classId,
    kind: "bbox",
    geometry: { kind: "bbox", x, y, w, h } as Geometry,
    frameId: null,
    serverId: null,
    dirty: false,
  };
}

function polygon(
  tempId: string,
  classId: string,
  points: [number, number][],
): AnnotationDraft {
  return {
    tempId,
    classId,
    kind: "polygon",
    geometry: { kind: "polygon", points } as Geometry,
    frameId: null,
    serverId: null,
    dirty: false,
  };
}

const SIZE: ImageBounds = { w: 100, h: 100 };

describe("computeAnnotationFlags — single-shape detectors", () => {
  it("flags tiny bbox (edge < 4 image-px)", () => {
    const f = computeAnnotationFlags([bbox("t1", "c", 10, 10, 3, 50)], SIZE);
    expect(f.find((x) => x.tempId === "t1" && x.code === "tiny")).toBeTruthy();
  });

  it("does NOT flag a 4×4 bbox as tiny (boundary inclusive)", () => {
    const f = computeAnnotationFlags([bbox("t1", "c", 10, 10, 4, 4)], SIZE);
    expect(f.find((x) => x.code === "tiny")).toBeFalsy();
  });

  it("flags off-image bbox when any edge breaks the image", () => {
    const f = computeAnnotationFlags([bbox("t1", "c", -2, 10, 50, 50)], SIZE);
    expect(f.find((x) => x.code === "off-image")).toBeTruthy();
  });

  it("skips off-image when no image bounds are supplied", () => {
    const f = computeAnnotationFlags([bbox("t1", "c", -2, 10, 50, 50)], null);
    expect(f.find((x) => x.code === "off-image")).toBeFalsy();
  });

  it("flags extreme-aspect bbox (>50:1)", () => {
    const f = computeAnnotationFlags([bbox("t1", "c", 0, 0, 100, 1)], SIZE);
    expect(f.find((x) => x.code === "extreme-aspect")).toBeTruthy();
  });

  it("flags whole-image bbox (>80% of image area)", () => {
    const f = computeAnnotationFlags([bbox("t1", "c", 0, 0, 95, 95)], SIZE);
    expect(f.find((x) => x.code === "whole-image")).toBeTruthy();
  });

  it("uses info severity (not warn) for whole-image", () => {
    const f = computeAnnotationFlags([bbox("t1", "c", 0, 0, 95, 95)], SIZE);
    const wholeFlag = f.find((x) => x.code === "whole-image");
    expect(wholeFlag?.severity).toBe("info");
  });

  it("flags polygon with fewer than 3 unique vertices", () => {
    const f = computeAnnotationFlags(
      [polygon("t1", "c", [[10, 10], [10, 10], [20, 20]])],
      SIZE,
    );
    expect(f.find((x) => x.code === "degenerate-polygon")).toBeTruthy();
  });

  it("does NOT flag a 3-unique-vertex polygon", () => {
    const f = computeAnnotationFlags(
      [polygon("t1", "c", [[10, 10], [50, 10], [30, 50]])],
      SIZE,
    );
    expect(f.find((x) => x.code === "degenerate-polygon")).toBeFalsy();
  });
});

describe("computeAnnotationFlags — duplicate-class-iou", () => {
  it("flags both members of a near-identical same-class pair", () => {
    const f = computeAnnotationFlags(
      [
        bbox("t1", "car", 10, 10, 50, 50),
        bbox("t2", "car", 11, 11, 50, 50),
      ],
      SIZE,
    );
    const dup1 = f.find((x) => x.tempId === "t1" && x.code === "duplicate-class-iou");
    const dup2 = f.find((x) => x.tempId === "t2" && x.code === "duplicate-class-iou");
    expect(dup1).toBeTruthy();
    expect(dup2).toBeTruthy();
  });

  it("does not flag pairs of DIFFERENT classes even when overlapping", () => {
    const f = computeAnnotationFlags(
      [
        bbox("t1", "car", 10, 10, 50, 50),
        bbox("t2", "truck", 11, 11, 50, 50),
      ],
      SIZE,
    );
    expect(f.find((x) => x.code === "duplicate-class-iou")).toBeFalsy();
  });

  it("does not flag pairs with IoU below 0.8 threshold", () => {
    const f = computeAnnotationFlags(
      [
        bbox("t1", "car", 10, 10, 50, 50),
        bbox("t2", "car", 50, 50, 50, 50),
      ],
      SIZE,
    );
    expect(f.find((x) => x.code === "duplicate-class-iou")).toBeFalsy();
  });
});

describe("computeAnnotationFlags — edge cases", () => {
  it("returns an empty array for empty input", () => {
    expect(computeAnnotationFlags([], SIZE)).toEqual([]);
  });

  it("handles tag annotations (no geometry) without crashing", () => {
    const tag: AnnotationDraft = {
      tempId: "g1",
      classId: "weather",
      kind: "tag",
      geometry: { kind: "tag" },
      frameId: null,
      serverId: null,
      dirty: false,
    };
    expect(computeAnnotationFlags([tag], SIZE)).toEqual([]);
  });

  it("can emit multiple flags for one annotation", () => {
    const f = computeAnnotationFlags([bbox("t1", "c", -5, 10, 8, 1)], SIZE);
    const codes = new Set(f.filter((x) => x.tempId === "t1").map((x) => x.code));
    expect(codes.has("tiny")).toBe(true);
    expect(codes.has("off-image")).toBe(true);
  });
});

describe("flagLabel", () => {
  it("returns a human-readable label for every code", () => {
    expect(flagLabel("tiny")).toMatch(/small/i);
    expect(flagLabel("off-image")).toMatch(/off-image/i);
    expect(flagLabel("extreme-aspect")).toMatch(/aspect/i);
    expect(flagLabel("whole-image")).toMatch(/whole/i);
    expect(flagLabel("degenerate-polygon")).toMatch(/degenerate/i);
    expect(flagLabel("duplicate-class-iou")).toMatch(/duplicate/i);
  });
});
