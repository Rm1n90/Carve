// Armin Mehri — mehri.armin@gmail.com
/**
 * Annotation health detectors.
 *
 * Surface suspicious annotations the moment they enter the store, so
 * the user catches problems during work instead of at export time. The
 * detectors here are pure — they read draft state + (optional) image
 * bounds and emit a ``Flag`` array. The right-rail HealthPanel renders
 * the aggregated count and per-item rows.
 *
 * The codes are stable strings so the UI can localise / theme without
 * touching this file. Severity is a UI hint, not a hard gate: nothing
 * here ever blocks save / export.
 *
 * Codes (see spec
 * docs/superpowers/specs/2026-05-16-annotator-accelerators-design.md F3):
 *   tiny                - bbox edge < 4 image-px
 *   off-image           - any vertex outside [0, image bounds]
 *   extreme-aspect      - bbox aspect ratio > 50:1 or < 1:50
 *   whole-image         - bbox area > 80% of image area
 *   degenerate-polygon  - polygon with fewer than 3 unique points
 *   duplicate-class-iou - same-class neighbour with bbox-IoU > 0.8
 */
import type { AnnotationDraft, Geometry } from "@/state/annotations";

export type FlagCode =
  | "tiny"
  | "off-image"
  | "extreme-aspect"
  | "whole-image"
  | "degenerate-polygon"
  | "duplicate-class-iou";

export type FlagSeverity = "warn" | "info";

export interface Flag {
  readonly tempId: string;
  readonly code: FlagCode;
  readonly severity: FlagSeverity;
}

export interface ImageBounds {
  readonly w: number;
  readonly h: number;
}

const MIN_BBOX_EDGE_PX = 4;
const MIN_POLYGON_UNIQUE_VERTICES = 3;
const EXTREME_ASPECT_RATIO = 50;
const WHOLE_IMAGE_AREA_FRAC = 0.8;
const DUPLICATE_IOU_THRESHOLD = 0.8;

interface BboxAabb {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

function geometryAabb(geom: Geometry): BboxAabb | null {
  if (geom.kind === "bbox") {
    return { x1: geom.x, y1: geom.y, x2: geom.x + geom.w, y2: geom.y + geom.h };
  }
  if (geom.kind === "polygon" && geom.points.length > 0) {
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    for (const [px, py] of geom.points) {
      if (px < x1) x1 = px;
      if (py < y1) y1 = py;
      if (px > x2) x2 = px;
      if (py > y2) y2 = py;
    }
    return { x1, y1, x2, y2 };
  }
  return null;
}

function uniquePolygonVertexCount(points: ReadonlyArray<[number, number]>): number {
  const seen = new Set<string>();
  for (const [px, py] of points) {
    seen.add(`${px}|${py}`);
  }
  return seen.size;
}

function iouBbox(a: BboxAabb, b: BboxAabb): number {
  const ix1 = Math.max(a.x1, b.x1);
  const iy1 = Math.max(a.y1, b.y1);
  const ix2 = Math.min(a.x2, b.x2);
  const iy2 = Math.min(a.y2, b.y2);
  const iw = ix2 - ix1;
  const ih = iy2 - iy1;
  if (iw <= 0 || ih <= 0) return 0;
  const inter = iw * ih;
  const areaA = (a.x2 - a.x1) * (a.y2 - a.y1);
  const areaB = (b.x2 - b.x1) * (b.y2 - b.y1);
  const union = areaA + areaB - inter;
  if (union <= 0) return 0;
  return inter / union;
}

function detectTiny(d: AnnotationDraft): Flag | null {
  const aabb = geometryAabb(d.geometry);
  if (!aabb) return null;
  const w = aabb.x2 - aabb.x1;
  const h = aabb.y2 - aabb.y1;
  if (w < MIN_BBOX_EDGE_PX || h < MIN_BBOX_EDGE_PX) {
    return { tempId: d.tempId, code: "tiny", severity: "warn" };
  }
  return null;
}

function detectOffImage(d: AnnotationDraft, image: ImageBounds): Flag | null {
  const aabb = geometryAabb(d.geometry);
  if (!aabb) return null;
  if (
    aabb.x1 < 0 ||
    aabb.y1 < 0 ||
    aabb.x2 > image.w ||
    aabb.y2 > image.h
  ) {
    return { tempId: d.tempId, code: "off-image", severity: "warn" };
  }
  return null;
}

function detectExtremeAspect(d: AnnotationDraft): Flag | null {
  const aabb = geometryAabb(d.geometry);
  if (!aabb) return null;
  const w = aabb.x2 - aabb.x1;
  const h = aabb.y2 - aabb.y1;
  if (w <= 0 || h <= 0) return null;
  const ratio = w / h;
  if (ratio > EXTREME_ASPECT_RATIO || ratio < 1 / EXTREME_ASPECT_RATIO) {
    return { tempId: d.tempId, code: "extreme-aspect", severity: "warn" };
  }
  return null;
}

function detectWholeImage(d: AnnotationDraft, image: ImageBounds): Flag | null {
  const aabb = geometryAabb(d.geometry);
  if (!aabb) return null;
  const w = Math.max(0, aabb.x2 - aabb.x1);
  const h = Math.max(0, aabb.y2 - aabb.y1);
  const imgArea = image.w * image.h;
  if (imgArea <= 0) return null;
  if ((w * h) / imgArea > WHOLE_IMAGE_AREA_FRAC) {
    return { tempId: d.tempId, code: "whole-image", severity: "info" };
  }
  return null;
}

function detectDegeneratePolygon(d: AnnotationDraft): Flag | null {
  if (d.geometry.kind !== "polygon") return null;
  if (uniquePolygonVertexCount(d.geometry.points) < MIN_POLYGON_UNIQUE_VERTICES) {
    return { tempId: d.tempId, code: "degenerate-polygon", severity: "warn" };
  }
  return null;
}

function detectDuplicates(drafts: ReadonlyArray<AnnotationDraft>): Flag[] {
  const byClass = new Map<string, { draft: AnnotationDraft; aabb: BboxAabb }[]>();
  for (const d of drafts) {
    const aabb = geometryAabb(d.geometry);
    if (!aabb) continue;
    const bucket = byClass.get(d.classId) ?? [];
    bucket.push({ draft: d, aabb });
    byClass.set(d.classId, bucket);
  }
  const flaggedIds = new Set<string>();
  for (const bucket of byClass.values()) {
    if (bucket.length < 2) continue;
    for (let i = 0; i < bucket.length; i += 1) {
      for (let j = i + 1; j < bucket.length; j += 1) {
        if (iouBbox(bucket[i].aabb, bucket[j].aabb) > DUPLICATE_IOU_THRESHOLD) {
          flaggedIds.add(bucket[i].draft.tempId);
          flaggedIds.add(bucket[j].draft.tempId);
        }
      }
    }
  }
  return Array.from(flaggedIds).map((id) => ({
    tempId: id,
    code: "duplicate-class-iou" as FlagCode,
    severity: "warn" as FlagSeverity,
  }));
}

/**
 * Aggregate every flag across the supplied drafts. The caller filters
 * for hidden / locked already — we don't reach into the store from a
 * pure helper.
 *
 * Image bounds are optional: when absent, the off-image and
 * whole-image detectors silently skip (rather than emit false
 * positives during cold-load when the texture hasn't measured itself
 * yet).
 */
export function computeAnnotationFlags(
  drafts: ReadonlyArray<AnnotationDraft>,
  image: ImageBounds | null,
): Flag[] {
  const out: Flag[] = [];
  for (const d of drafts) {
    const tiny = detectTiny(d);
    if (tiny) out.push(tiny);
    if (image) {
      const off = detectOffImage(d, image);
      if (off) out.push(off);
      const whole = detectWholeImage(d, image);
      if (whole) out.push(whole);
    }
    const aspect = detectExtremeAspect(d);
    if (aspect) out.push(aspect);
    const degen = detectDegeneratePolygon(d);
    if (degen) out.push(degen);
  }
  out.push(...detectDuplicates(drafts));
  return out;
}

export function flagLabel(code: FlagCode): string {
  switch (code) {
    case "tiny":
      return "Very small";
    case "off-image":
      return "Off-image";
    case "extreme-aspect":
      return "Extreme aspect";
    case "whole-image":
      return "Covers whole image";
    case "degenerate-polygon":
      return "Degenerate polygon";
    case "duplicate-class-iou":
      return "Likely duplicate";
  }
}
