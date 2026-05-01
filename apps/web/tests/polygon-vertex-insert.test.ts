/**
 * Plan-09 Phase 5 Task 12 — polygon vertex insert via alt-click.
 *
 * Covers the pure helpers (`hitTestEdge`, `insertVertex`) plus an
 * integration check that an alt-click branch updates the store's
 * geometry with the inserted vertex.
 */
import { beforeEach, describe, expect, it } from "vitest";

import {
  INSERT_TOLERANCE_PX,
  hitTestEdge,
  insertVertex,
} from "@/canvas/polygonEdit";
import { useAnnotations, type Polygon } from "@/state/annotations";

function poly(...pts: [number, number][]): Polygon {
  return { kind: "polygon", points: pts };
}

describe("hitTestEdge", () => {
  it("returns the right edge index + projected point near an edge", () => {
    const p = poly([0, 0], [100, 0], [100, 100], [0, 100]);
    // 1px above the top edge (y=0) at x=50 → edge 0, projected (50,0).
    const hit = hitTestEdge(p, { x: 50, y: 1 });
    expect(hit).not.toBeNull();
    expect(hit!.edgeIndex).toBe(0);
    expect(hit!.projected.x).toBeCloseTo(50);
    expect(hit!.projected.y).toBeCloseTo(0);
  });

  it("hits the right edge for the right vertical edge", () => {
    const p = poly([0, 0], [100, 0], [100, 100], [0, 100]);
    // Just outside x=100, mid-height — that's edge 1 (100,0)→(100,100).
    const hit = hitTestEdge(p, { x: 102, y: 50 });
    expect(hit).not.toBeNull();
    expect(hit!.edgeIndex).toBe(1);
    expect(hit!.projected.x).toBeCloseTo(100);
    expect(hit!.projected.y).toBeCloseTo(50);
  });

  it("hits the closing edge (last → first) too", () => {
    const p = poly([0, 0], [100, 0], [100, 100], [0, 100]);
    // 1px outside the left edge (x=0), mid-height — that's edge 3.
    const hit = hitTestEdge(p, { x: -1, y: 50 });
    expect(hit).not.toBeNull();
    expect(hit!.edgeIndex).toBe(3);
    expect(hit!.projected.x).toBeCloseTo(0);
    expect(hit!.projected.y).toBeCloseTo(50);
  });

  it("returns null when far from every edge", () => {
    const p = poly([0, 0], [100, 0], [100, 100], [0, 100]);
    expect(hitTestEdge(p, { x: 50, y: 50 })).toBeNull();
  });

  it("clamps the projection to the segment, not the infinite line", () => {
    // A click well past the end of edge 0 should NOT count as a hit on
    // edge 0 (the projection would land beyond the (100,0) endpoint).
    const p = poly([0, 0], [100, 0], [100, 100]);
    const hit = hitTestEdge(p, { x: 200, y: 1 });
    // The closest point on edge 0's segment is (100, 0), distance ~100,
    // so it must NOT register a hit at the default tolerance.
    expect(hit === null || hit.edgeIndex !== 0).toBe(true);
  });

  it("respects a custom tolerance", () => {
    const p = poly([0, 0], [100, 0], [100, 100]);
    expect(
      hitTestEdge(p, { x: 50, y: INSERT_TOLERANCE_PX + 5 }, 2),
    ).toBeNull();
    expect(
      hitTestEdge(p, { x: 50, y: INSERT_TOLERANCE_PX + 5 }, 20),
    ).not.toBeNull();
  });
});

describe("insertVertex", () => {
  it("inserts the new vertex between the edge's two endpoints", () => {
    const p = poly([0, 0], [100, 0], [100, 100], [0, 100]);
    const next = insertVertex(p, 0, { x: 50, y: 0 });
    expect(next.points).toEqual([
      [0, 0],
      [50, 0],
      [100, 0],
      [100, 100],
      [0, 100],
    ]);
  });

  it("inserts on the closing edge (index n-1) before wrap-around", () => {
    const p = poly([0, 0], [100, 0], [100, 100], [0, 100]);
    const next = insertVertex(p, 3, { x: 0, y: 50 });
    expect(next.points).toEqual([
      [0, 0],
      [100, 0],
      [100, 100],
      [0, 100],
      [0, 50],
    ]);
  });

  it("returns the original polygon when edgeIndex is out of range", () => {
    const p = poly([0, 0], [100, 0], [100, 100]);
    expect(insertVertex(p, -1, { x: 0, y: 0 }).points).toBe(p.points);
    expect(insertVertex(p, 99, { x: 0, y: 0 }).points).toBe(p.points);
  });

  it("does not mutate the original polygon (immutable update)", () => {
    const original = poly([0, 0], [100, 0], [100, 100]);
    const before = original.points.slice();
    insertVertex(original, 0, { x: 50, y: 0 });
    expect(original.points).toEqual(before);
  });
});

describe("alt-click vertex insert (store integration)", () => {
  beforeEach(() => {
    useAnnotations.getState().reset([]);
  });

  it("alt-click on a selected polygon's edge updates byId[id].geometry.points", () => {
    const initial = poly([0, 0], [100, 0], [100, 100], [0, 100]);
    useAnnotations.getState().add({
      tempId: "p-1",
      classId: "c-1",
      kind: "polygon",
      geometry: initial,
      frameId: "f-1",
      serverId: null,
      dirty: true,
    });
    useAnnotations.getState().select("p-1");

    // Simulate the AnnotationCanvas alt-click branch.
    const cursor = { x: 50, y: 1 };
    const edge = hitTestEdge(initial, cursor);
    expect(edge).not.toBeNull();
    const nextPoly = insertVertex(initial, edge!.edgeIndex, edge!.projected);
    useAnnotations.getState().update("p-1", { geometry: nextPoly });

    const stored = useAnnotations.getState().byId["p-1"].geometry as Polygon;
    expect(stored.kind).toBe("polygon");
    expect(stored.points).toHaveLength(5);
    expect(stored.points[1]).toEqual([50, 0]);
  });
});
