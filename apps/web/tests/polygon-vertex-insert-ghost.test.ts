/**
 * Plan-09b Task 2 — alt+hover edge-insert ghost dot.
 *
 * Pixi-mock integration for the cursor-tool ghost overlay is brittle to
 * exercise via the AnnotationCanvas reconcile pipeline (lazy-imported
 * Graphics, async paint), so per the plan we downgrade to a pure unit
 * test of the ``shouldShowEdgeGhost`` predicate that gates the paint.
 * The math (``hitTestEdge``) and the alt-click store path are already
 * covered by ``polygon-vertex-insert.test.ts``.
 */
import { describe, expect, it } from "vitest";

import { shouldShowEdgeGhost } from "@/canvas/polygonEdit";

const HIT = { edgeIndex: 0, projected: { x: 50, y: 0 } };

describe("shouldShowEdgeGhost (Plan-09b Task 2 predicate)", () => {
  it("returns true when cursor tool + alt + polygon selected + edge hit", () => {
    expect(
      shouldShowEdgeGhost({
        tool: "cursor",
        alt: true,
        polygonSelected: true,
        hit: HIT,
      }),
    ).toBe(true);
  });

  it("returns false when alt is not held", () => {
    expect(
      shouldShowEdgeGhost({
        tool: "cursor",
        alt: false,
        polygonSelected: true,
        hit: HIT,
      }),
    ).toBe(false);
  });

  it("returns false when no polygon is selected", () => {
    expect(
      shouldShowEdgeGhost({
        tool: "cursor",
        alt: true,
        polygonSelected: false,
        hit: HIT,
      }),
    ).toBe(false);
  });

  it("returns false when the cursor isn't near an edge", () => {
    expect(
      shouldShowEdgeGhost({
        tool: "cursor",
        alt: true,
        polygonSelected: true,
        hit: null,
      }),
    ).toBe(false);
  });

  it("returns false for non-cursor tools (bbox, polygon, mask, sam, tag)", () => {
    for (const tool of ["bbox", "polygon", "mask", "sam", "tag"]) {
      expect(
        shouldShowEdgeGhost({
          tool,
          alt: true,
          polygonSelected: true,
          hit: HIT,
        }),
      ).toBe(false);
    }
  });
});
