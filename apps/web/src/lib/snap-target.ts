// Armin Mehri — mehri.armin@gmail.com
/**
 * Snap-target finder for the bbox / polygon drawing tools.
 *
 * When the user holds ``Shift`` while drawing, the canvas calls
 * ``findSnapTarget`` on every pointer-move to lock the cursor onto
 * the nearest existing vertex / edge within an 8 screen-pixel
 * threshold. Returns the snapped point and the kind ("vertex" or
 * "edge") so the canvas can render a visual hint at the target.
 *
 * Pure — no DOM, no zustand. The caller supplies the visible drafts
 * + the in-progress shape's own vertices (so the polygon tool doesn't
 * snap to itself).
 *
 * Spec ``docs/superpowers/specs/2026-05-16-annotator-accelerators-design.md`` F6.
 */
import type { AnnotationDraft, Geometry } from "@/state/annotations";

/**
 * Maximum image-space distance the snap will reach even at very low
 * zoom. Without this cap the 8-screen-px threshold can balloon to
 * dozens of image pixels when the user is zoomed way out, which
 * makes snapping feel like teleportation. 24px is the empirical
 * limit at which a snap is still "intentional".
 */
const SNAP_IMAGE_PX_MAX = 24;

/** Threshold expressed in screen pixels — felt distance stays
 *  constant across zoom levels. */
export const DEFAULT_SNAP_SCREEN_PX = 8;

export type SnapKind = "vertex" | "edge";

export interface SnapResult {
  readonly x: number;
  readonly y: number;
  readonly kind: SnapKind;
  /** Image-space distance from the cursor to the snap point. Useful
   *  for unit tests; the canvas mostly ignores it. */
  readonly distance: number;
}

interface Edge {
  ax: number;
  ay: number;
  bx: number;
  by: number;
}

function squaredDistance(ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  return dx * dx + dy * dy;
}

function projectPointOntoEdge(
  cx: number,
  cy: number,
  edge: Edge,
): { x: number; y: number } | null {
  const dx = edge.bx - edge.ax;
  const dy = edge.by - edge.ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return null;
  let t = ((cx - edge.ax) * dx + (cy - edge.ay) * dy) / lenSq;
  if (t < 0) t = 0;
  if (t > 1) t = 1;
  return { x: edge.ax + t * dx, y: edge.ay + t * dy };
}

function geometryVertices(geom: Geometry): Array<[number, number]> {
  if (geom.kind === "bbox") {
    const { x, y, w, h } = geom;
    return [
      [x, y],
      [x + w, y],
      [x + w, y + h],
      [x, y + h],
    ];
  }
  if (geom.kind === "polygon") {
    return geom.points.map(([px, py]) => [px, py] as [number, number]);
  }
  return [];
}

function geometryEdges(geom: Geometry): Edge[] {
  const verts = geometryVertices(geom);
  if (verts.length < 2) return [];
  const out: Edge[] = [];
  for (let i = 0; i < verts.length; i += 1) {
    const j = (i + 1) % verts.length;
    out.push({
      ax: verts[i][0],
      ay: verts[i][1],
      bx: verts[j][0],
      by: verts[j][1],
    });
  }
  return out;
}

export interface SnapFilter {
  readonly frameId: string | null;
  readonly hiddenAnnIds: ReadonlySet<string>;
  readonly hiddenClassIds: ReadonlySet<string>;
  readonly excludeTempId: string | null;
  readonly excludeVertices: ReadonlyArray<[number, number]>;
}

/**
 * Find the nearest vertex / edge to ``cursor`` within
 * ``min(thresholdScreenPx / scale, SNAP_IMAGE_PX_MAX)``. Returns
 * ``null`` when no candidate falls inside the threshold.
 *
 * ``scale`` is the canvas's image→screen zoom factor (pixels-per-
 * image-pixel). At 1× a screen pixel equals an image pixel; at 2×
 * the image is rendered 2× larger so the screen threshold corresponds
 * to half the image distance.
 *
 * Vertex hits beat edge hits at equal distance — vertex snaps are
 * usually what the user wants (shared corner between two boxes).
 */
export function findSnapTarget(
  cursor: { x: number; y: number },
  scale: number,
  drafts: ReadonlyArray<AnnotationDraft>,
  filter: SnapFilter,
  thresholdScreenPx: number = DEFAULT_SNAP_SCREEN_PX,
): SnapResult | null {
  const safeScale = scale > 0 ? scale : 1;
  const imagePxThreshold = Math.min(
    thresholdScreenPx / safeScale,
    SNAP_IMAGE_PX_MAX,
  );
  const thresholdSq = imagePxThreshold * imagePxThreshold;

  const excludeVertexSet = new Set<string>();
  for (const [vx, vy] of filter.excludeVertices) {
    excludeVertexSet.add(`${vx}|${vy}`);
  }

  let bestVertex: { x: number; y: number; distSq: number } | null = null;
  let bestEdge: { x: number; y: number; distSq: number } | null = null;

  for (const d of drafts) {
    if (d.frameId !== filter.frameId) continue;
    if (d.tempId === filter.excludeTempId) continue;
    if (filter.hiddenAnnIds.has(d.tempId)) continue;
    if (filter.hiddenClassIds.has(d.classId)) continue;
    for (const [vx, vy] of geometryVertices(d.geometry)) {
      if (excludeVertexSet.has(`${vx}|${vy}`)) continue;
      const distSq = squaredDistance(cursor.x, cursor.y, vx, vy);
      if (distSq <= thresholdSq) {
        if (!bestVertex || distSq < bestVertex.distSq) {
          bestVertex = { x: vx, y: vy, distSq };
        }
      }
    }
    for (const edge of geometryEdges(d.geometry)) {
      const proj = projectPointOntoEdge(cursor.x, cursor.y, edge);
      if (!proj) continue;
      const distSq = squaredDistance(cursor.x, cursor.y, proj.x, proj.y);
      if (distSq <= thresholdSq) {
        if (!bestEdge || distSq < bestEdge.distSq) {
          bestEdge = { x: proj.x, y: proj.y, distSq };
        }
      }
    }
  }

  // Vertex bias: when the cursor is well within "corner territory"
  // (≤ 40 % of the threshold) we always pick the vertex, even when
  // an edge is geometrically closer. Reason: at typical zoom the
  // perpendicular projection onto an adjacent edge will always be
  // slightly shorter than the diagonal to the corner, so a pure
  // closest-point rule would prevent corner-snapping in the natural
  // "approach the corner from inside the box" case. CVAT and
  // Roboflow both use the same bias.
  const vertexPreferThresholdSq = thresholdSq * 0.4 * 0.4;
  if (bestVertex && bestVertex.distSq <= vertexPreferThresholdSq) {
    return {
      x: bestVertex.x,
      y: bestVertex.y,
      kind: "vertex",
      distance: Math.sqrt(bestVertex.distSq),
    };
  }
  // Outside the vertex-prefer zone: closest wins, vertex breaking ties.
  if (bestVertex && (!bestEdge || bestVertex.distSq <= bestEdge.distSq)) {
    return {
      x: bestVertex.x,
      y: bestVertex.y,
      kind: "vertex",
      distance: Math.sqrt(bestVertex.distSq),
    };
  }
  if (bestEdge) {
    return {
      x: bestEdge.x,
      y: bestEdge.y,
      kind: "edge",
      distance: Math.sqrt(bestEdge.distSq),
    };
  }
  return null;
}
