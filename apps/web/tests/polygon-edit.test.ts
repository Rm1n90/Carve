/**
 * Tests for the pure polygon vertex-edit utilities. The Canvas pointer
 * routing is a thin wrapper that calls these same functions, so covering
 * the math here gives the cursor-tool / context-menu behaviour confidence
 * without booting Pixi.
 *
 * Phase A core 3.
 */
import { describe, expect, it } from "vitest";

import {
  POLY_MIN_VERTICES,
  POLY_VERTEX_HIT_HALO,
  applyVertexDelete,
  applyVertexTranslate,
  hitTestVertex,
} from "@/canvas/polygonEdit";
import type { Polygon } from "@/state/annotations";

function poly(...pts: [number, number][]): Polygon {
  return { kind: "polygon", points: pts };
}

describe("polygon hitTestVertex", () => {
  it("returns null when cursor is far from every vertex", () => {
    const p = poly([0, 0], [100, 0], [100, 100], [0, 100]);
    expect(hitTestVertex(p, { x: 50, y: 50 })).toBeNull();
  });

  it("returns the matching vertex index when the cursor is within halo", () => {
    const p = poly([0, 0], [100, 0], [100, 100]);
    expect(hitTestVertex(p, { x: POLY_VERTEX_HIT_HALO, y: 0 })).toBe(0);
    expect(hitTestVertex(p, { x: 100, y: POLY_VERTEX_HIT_HALO })).toBe(1);
    expect(hitTestVertex(p, { x: 100 - POLY_VERTEX_HIT_HALO, y: 100 })).toBe(2);
  });

  it("returns null exactly outside the halo", () => {
    const p = poly([0, 0], [50, 0], [50, 50]);
    expect(hitTestVertex(p, { x: POLY_VERTEX_HIT_HALO + 1, y: 0 })).toBeNull();
  });
});

describe("polygon applyVertexTranslate", () => {
  it("returns a new polygon with the indexed vertex moved", () => {
    const original = poly([0, 0], [10, 0], [10, 10], [0, 10]);
    const next = applyVertexTranslate(original, 2, { x: 20, y: 20 });
    expect(next.points).toEqual([
      [0, 0],
      [10, 0],
      [20, 20],
      [0, 10],
    ]);
    // Source polygon untouched (immutability).
    expect(original.points[2]).toEqual([10, 10]);
  });

  it("returns the original polygon when index is out of range", () => {
    const original = poly([0, 0], [10, 0], [10, 10]);
    expect(applyVertexTranslate(original, -1, { x: 5, y: 5 })).toBe(original);
    expect(applyVertexTranslate(original, 99, { x: 5, y: 5 })).toBe(original);
  });

  // v2.5.2 — vertex coordinates must never escape the image.
  it("clamps the moved vertex to image bounds when bounds are provided", () => {
    const original = poly([0, 0], [10, 0], [10, 10], [0, 10]);
    const next = applyVertexTranslate(original, 0, { x: -100, y: 200 }, { w: 100, h: 80 });
    // (-100, 200) → (0, 80) on a 100x80 image.
    expect(next.points[0]).toEqual([0, 80]);
    // Other vertices unchanged.
    expect(next.points[1]).toEqual([10, 0]);
    expect(next.points[2]).toEqual([10, 10]);
    expect(next.points[3]).toEqual([0, 10]);
  });

  it("leaves vertex coords untouched when bounds is null", () => {
    const original = poly([0, 0], [10, 0], [10, 10]);
    const next = applyVertexTranslate(original, 0, { x: -100, y: 200 });
    expect(next.points[0]).toEqual([-100, 200]);
  });
});

describe("polygon applyVertexDelete", () => {
  it("removes the indexed vertex", () => {
    const original = poly([0, 0], [10, 0], [10, 10], [0, 10]);
    const next = applyVertexDelete(original, 1);
    expect(next.points).toEqual([
      [0, 0],
      [10, 10],
      [0, 10],
    ]);
  });

  it("refuses to delete when fewer than three vertices would remain", () => {
    const original = poly([0, 0], [10, 0], [10, 10]);
    expect(applyVertexDelete(original, 0)).toBe(original);
    expect(POLY_MIN_VERTICES).toBe(3);
  });

  it("returns the original polygon when index is out of range", () => {
    const original = poly([0, 0], [10, 0], [10, 10], [0, 10]);
    expect(applyVertexDelete(original, -1)).toBe(original);
    expect(applyVertexDelete(original, 99)).toBe(original);
  });
});
