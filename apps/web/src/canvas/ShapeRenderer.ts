import type { Graphics } from "pixi.js";
import type { Bbox, Polygon as Poly } from "@/state/annotations";

export function renderBbox(g: Graphics, b: Bbox, color: number, selected: boolean): void {
  g.clear();
  g.rect(b.x, b.y, b.w, b.h);
  g.stroke({ color, width: selected ? 3 : 2, alpha: 1 });
  g.fill({ color, alpha: selected ? 0.18 : 0.08 });
}

export function renderPolygon(g: Graphics, p: Poly, color: number, selected: boolean): void {
  if (p.points.length === 0) return;
  g.clear();
  g.moveTo(p.points[0][0], p.points[0][1]);
  for (let i = 1; i < p.points.length; i += 1) {
    g.lineTo(p.points[i][0], p.points[i][1]);
  }
  g.lineTo(p.points[0][0], p.points[0][1]);
  g.stroke({ color, width: selected ? 3 : 2, alpha: 1 });
  g.fill({ color, alpha: selected ? 0.18 : 0.08 });
}
