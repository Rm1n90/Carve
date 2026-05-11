// Armin Mehri — mehri.armin@gmail.com
//
// Plan-17 — SAM-backed geometry conversions.
//
// Server roundtrip helpers used by the right-click "Convert ▸" submenu
// and the YOLO/Auto-annotate post-processing checkboxes.
//
// Both supported directions (BBox→Polygon, Polygon→refined Polygon)
// reduce to "given an axis-aligned box on this asset, give me back a
// SAM polygon", which `samApi.boxPrompt` already provides.
import { samApi } from "@/api/sam";
import { modelsApi } from "@/api/phase2";
import { bboxOfGeometry } from "@/lib/geometryConvert";
import type { Bbox, Geometry } from "@/state/annotations";

/**
 * Plan-17 — make sure a SAM predictor is loaded server-side before we
 * try to encode + box-prompt. Idempotent and cheap when SAM is already
 * ready; triggers a hot-swap to the active variant and polls the load
 * status when it isn't.
 *
 * Throws if the load takes longer than ``timeoutMs`` or fails — the
 * caller's catch surfaces this to the user as a toast.
 *
 * v3.30 — exported so the Auto-Annotate Run flow can pre-flight a
 * load before firing the actual inference request. Same idempotent
 * behaviour: a no-op when SAM is already ready.
 */
export async function ensureSamReady(timeoutMs = 60_000): Promise<void> {
  // Quick path — already loaded.
  let status = await modelsApi.samStatus();
  if (status.state === "ready") return;
  // Need to kick a load. Use whatever variant /sam-active reports as
  // the active one; this lets the user's last picked variant (e.g.
  // SAM 3.1) win over the API's hardcoded ``sam2.1-tiny`` default.
  if (status.state !== "loading") {
    const active = await modelsApi.samActive();
    try {
      await modelsApi.samSetActive(active.active);
    } catch {
      /* 409 switch-in-progress is fine — we just poll below */
    }
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 600));
    status = await modelsApi.samStatus();
    if (status.state === "ready") return;
    if (status.state === "error") {
      throw new Error(status.error || "SAM load failed.");
    }
  }
  throw new Error("SAM load timed out (>60s).");
}

export interface SamRefineParams {
  assetId: string;
  frameId?: string | null;
  /** xyxy in image-space pixels. */
  box: [number, number, number, number];
}

/**
 * Run a single SAM box-prompt and return the produced polygon vertices.
 *
 * Uses the regular ``/sam/decode`` endpoint with an xyxy box parameter
 * (and empty point/label arrays) instead of the SAM 3-only
 * ``/sam/box-prompt`` route — the decode path works on every SAM
 * variant the project ships (sam2.1-tiny / small / base+ / large,
 * sam3, sam3.1) so Convert/Refine succeed regardless of which model
 * the user has loaded.
 *
 * Returns ``null`` when SAM did not produce a usable polygon (e.g.
 * the box is too small to segment, no candidate above noise, or the
 * variant returns an empty polygon list) — the caller keeps the
 * original geometry instead of replacing it with garbage.
 */
export async function samBoxToPolygonPoints({
  assetId,
  frameId,
  box,
}: SamRefineParams): Promise<[number, number][] | null> {
  // Plan-17 — make sure SAM is loaded server-side. Without this the
  // first Convert/Refine after a fresh page load 503s because no
  // predictor is mounted yet. Independent of the editor's active
  // tool / SAM mode (point/box/track) — we never need the user to
  // click into the Smart tool first.
  await ensureSamReady();
  // Encode caches the image embedding server-side and returns the
  // image_hash that decode references. Idempotent by image hash so
  // a recent encode is a near-free server hit.
  const enc = await samApi.encode(assetId, frameId ?? null);
  const result = await samApi.decode(
    assetId,
    enc.image_hash,
    [],
    [],
    undefined,
    box,
  );
  if (!result || !result.polygon || result.polygon.length < 3) {
    return null;
  }
  return result.polygon.map(([x, y]) => [x, y] as [number, number]);
}

/**
 * Given any geometry on a known asset, compute its bounding box and
 * ask SAM for a polygon for that region. Returns the new vertex list
 * or null on failure.
 */
export async function samPolygonForGeometry({
  assetId,
  frameId,
  geometry,
}: {
  assetId: string;
  frameId?: string | null;
  geometry: Geometry;
}): Promise<[number, number][] | null> {
  const box = bboxOfGeometry(geometry);
  if (!box) return null;
  if (box.w < 1 || box.h < 1) return null;
  const xyxy: [number, number, number, number] = [
    box.x,
    box.y,
    box.x + box.w,
    box.y + box.h,
  ];
  return samBoxToPolygonPoints({ assetId, frameId, box: xyxy });
}

/**
 * Inflate a Bbox a few pixels in every direction (clamped to optional
 * image bounds). Useful before refining a tight YOLO mask polygon —
 * SAM gets a little boundary context instead of being clipped to the
 * predicted edge.
 */
export function inflateBbox(
  b: Bbox,
  padPx: number,
  bounds?: { w: number; h: number },
): Bbox {
  let x = b.x - padPx;
  let y = b.y - padPx;
  let w = b.w + 2 * padPx;
  let h = b.h + 2 * padPx;
  if (bounds) {
    if (x < 0) {
      w += x;
      x = 0;
    }
    if (y < 0) {
      h += y;
      y = 0;
    }
    if (x + w > bounds.w) w = Math.max(0, bounds.w - x);
    if (y + h > bounds.h) h = Math.max(0, bounds.h - y);
  }
  return { kind: "bbox", x, y, w, h };
}
