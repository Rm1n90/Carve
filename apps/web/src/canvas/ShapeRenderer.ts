import type { Graphics } from "pixi.js";
import type { Bbox, Polygon as Poly } from "@/state/annotations";

/**
 * Names of the 8 selection handles on a bbox: 4 corners + 4 edges.
 * The order matters for hit-testing: corners precede edges so a corner
 * click takes priority when handles overlap (which they don't, but the
 * convention keeps callers consistent).
 */
export type BboxHandleName =
  | "nw"
  | "ne"
  | "se"
  | "sw"
  | "n"
  | "e"
  | "s"
  | "w";

export const BBOX_HANDLE_NAMES: readonly BboxHandleName[] = [
  "nw",
  "ne",
  "se",
  "sw",
  "n",
  "e",
  "s",
  "w",
] as const;

/** Size (px) of each handle square in image-space. Drawn centred on the
 * handle's anchor point. */
export const BBOX_HANDLE_SIZE_PX = 8;

export interface BboxHandleSpec {
  name: BboxHandleName;
  /** Centre x in image coordinates. */
  cx: number;
  /** Centre y in image coordinates. */
  cy: number;
}

/** Compute the 8 handle anchor points for a bbox in image coordinates.
 * Caller uses this both to render handles AND to hit-test pointer events
 * — keeping the geometry in one place avoids drift. */
export function getBboxHandlePositions(b: Bbox): BboxHandleSpec[] {
  const xMid = b.x + b.w / 2;
  const yMid = b.y + b.h / 2;
  const xRight = b.x + b.w;
  const yBottom = b.y + b.h;
  return [
    { name: "nw", cx: b.x, cy: b.y },
    { name: "ne", cx: xRight, cy: b.y },
    { name: "se", cx: xRight, cy: yBottom },
    { name: "sw", cx: b.x, cy: yBottom },
    { name: "n", cx: xMid, cy: b.y },
    { name: "e", cx: xRight, cy: yMid },
    { name: "s", cx: xMid, cy: yBottom },
    { name: "w", cx: b.x, cy: yMid },
  ];
}

/** CSS cursor name for a given handle, used by the canvas pointer handler. */
export function cursorForHandle(name: BboxHandleName): string {
  switch (name) {
    case "nw":
    case "se":
      return "nwse-resize";
    case "ne":
    case "sw":
      return "nesw-resize";
    case "n":
    case "s":
      return "ns-resize";
    case "e":
    case "w":
      return "ew-resize";
  }
}

const HANDLE_INDIGO = 0x6366f1;
const HANDLE_FILL = 0xffffff;

export function renderBbox(
  g: Graphics,
  b: Bbox,
  color: number,
  selected: boolean,
  /** When true AND ``selected`` is true, draw the 8 resize handles.
   * Callers pass true only when the cursor tool is active — otherwise
   * handles would visually compete with the bbox tool's drag preview. */
  showHandles = false,
  /**
   * Fill alpha when ``selected`` is false. Defaults to 0.08 (legacy).
   * Wired from `useEditorSettings.opacity` so the user can dial it.
   */
  fillAlpha = 0.08,
  /** Fill alpha when ``selected`` is true. Defaults to 0.18 (legacy). */
  selectedFillAlpha = 0.18,
): void {
  g.clear();
  g.rect(b.x, b.y, b.w, b.h);
  g.stroke({ color, width: selected ? 3 : 2, alpha: 1 });
  g.fill({ color, alpha: selected ? selectedFillAlpha : fillAlpha });

  if (!selected || !showHandles) return;

  const half = BBOX_HANDLE_SIZE_PX / 2;
  for (const spec of getBboxHandlePositions(b)) {
    g.rect(spec.cx - half, spec.cy - half, BBOX_HANDLE_SIZE_PX, BBOX_HANDLE_SIZE_PX);
    g.fill({ color: HANDLE_FILL, alpha: 1 });
    g.stroke({ color: HANDLE_INDIGO, width: 1, alpha: 1 });
  }
}

export function renderPolygon(
  g: Graphics,
  p: Poly,
  color: number,
  selected: boolean,
  /** When true AND ``selected`` is true, draw the vertex edit handles.
   * Callers pass true only when the cursor tool is active — otherwise the
   * vertex handles would visually compete with the polygon-tool's preview. */
  showHandles = false,
  fillAlpha = 0.08,
  selectedFillAlpha = 0.18,
): void {
  if (p.points.length === 0) return;
  g.clear();
  g.moveTo(p.points[0][0], p.points[0][1]);
  for (let i = 1; i < p.points.length; i += 1) {
    g.lineTo(p.points[i][0], p.points[i][1]);
  }
  g.lineTo(p.points[0][0], p.points[0][1]);
  g.stroke({ color, width: selected ? 3 : 2, alpha: 1 });
  g.fill({ color, alpha: selected ? selectedFillAlpha : fillAlpha });

  if (!selected || !showHandles) return;
  const half = BBOX_HANDLE_SIZE_PX / 2;
  for (const [vx, vy] of p.points) {
    g.rect(vx - half, vy - half, BBOX_HANDLE_SIZE_PX, BBOX_HANDLE_SIZE_PX);
    g.fill({ color: HANDLE_FILL, alpha: 1 });
    g.stroke({ color: HANDLE_INDIGO, width: 1, alpha: 1 });
  }
}
