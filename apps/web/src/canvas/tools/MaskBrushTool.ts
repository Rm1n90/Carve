import { useAnnotations } from "@/state/annotations";
import type { Point } from "./BboxTool";
import { MaskRasterizer } from "@/canvas/MaskRasterizer";

const DEFAULT_RADIUS = 25;
const RADIUS_STEP_PX = 5;
const MIN_RADIUS = 1;
const MAX_RADIUS = 200;
const DEFAULT_HARDNESS = 0.7;

/**
 * Mask brush tool — drives a `MaskRasterizer` for live painting and
 * commits the painted region as a `mask_rle` annotation on Enter.
 *
 * Pointer model: `onPointerDown(p, button)` starts a stroke
 * (left/0 = draw, right/2 = erase). `onPointerMove` extends it.
 * `onPointerUp` ends it. `[` / `]` keys decrement / increment the
 * radius by 5px.
 *
 * This class survived several iterations — early versions painted
 * directly into a `Uint8Array`, which made live preview impossible.
 * The current version delegates to `MaskRasterizer`'s OffscreenCanvas
 * so the canvas can be rendered as a Pixi sprite during drag.
 */
export class MaskBrushTool {
  private rasterizer: MaskRasterizer | null = null;
  private painting = false;
  private erasing = false;
  private strokePoints: Array<[number, number]> = [];
  private radius: number;
  /**
   * Plan 09 Task 11 — brush hardness in 0..1. ``1.0`` reproduces the
   * legacy solid disc; ``< 1.0`` adds a feathered falloff. Default
   * ``0.7`` — slightly soft edge that matches modern brush UX.
   */
  private hardness: number = DEFAULT_HARDNESS;

  constructor(
    private getActiveClassId: () => string | null,
    private getFrameId: () => string | null,
    private getImageSize: () => { w: number; h: number },
    initialRadius: number = DEFAULT_RADIUS,
    private generateTempId: () => string = () => `t-${Math.random().toString(36).slice(2)}`,
  ) {
    this.radius = clampRadius(initialRadius);
  }

  /** Plan 09 Task 11 — set hardness (clamped 0..1). */
  setHardness(h: number): void {
    if (!Number.isFinite(h)) return;
    this.hardness = Math.max(0, Math.min(1, h));
  }

  getHardness(): number {
    return this.hardness;
  }

  setEraser(on: boolean): void {
    this.erasing = on;
  }

  isErasing(): boolean {
    return this.erasing;
  }

  getRadius(): number {
    return this.radius;
  }

  setRadius(r: number): void {
    this.radius = clampRadius(r);
  }

  /** Increment radius by `delta` px and return the new value. */
  bumpRadius(delta: number): number {
    this.radius = clampRadius(this.radius + delta);
    return this.radius;
  }

  /** The active rasterizer (lazily created). Used by AnnotationCanvas to
   *  render a live preview sprite. May be `null` until first paint. */
  getRasterizer(): MaskRasterizer | null {
    return this.rasterizer;
  }

  /** Whether the current pointer state is mid-stroke (drag in progress). */
  isPainting(): boolean {
    return this.painting;
  }

  private ensureRasterizer(): MaskRasterizer {
    if (!this.rasterizer) {
      const { w, h } = this.getImageSize();
      this.rasterizer = new MaskRasterizer(w, h);
    }
    return this.rasterizer;
  }

  onPointerDown(p: Point, button = 0): void {
    const r = this.ensureRasterizer();
    this.painting = true;
    // Right-mouse drag erases. Mouse left/no-button paints (or erases when
    // the explicit eraser toggle is on).
    const eraseOnDrag = button === 2 || this.erasing;
    this.strokePoints = [[p.x, p.y]];
    r.paintBrushHardness(p.x, p.y, this.radius, this.hardness, eraseOnDrag ? "erase" : "draw");
  }

  onPointerMove(p: Point): void {
    if (!this.painting || !this.rasterizer) return;
    const last = this.strokePoints[this.strokePoints.length - 1];
    if (last && last[0] === p.x && last[1] === p.y) return;
    this.strokePoints.push([p.x, p.y]);
    // Plan 09 Task 11 — interpolate dabs along the segment so each
    // sample is hardness-aware. ``paintStroke`` (thick line) doesn't
    // honour the alpha falloff, so we walk the segment in steps of
    // half the radius and call paintBrushHardness at each step.
    if (this.strokePoints.length >= 2) {
      const a = this.strokePoints[this.strokePoints.length - 2];
      const b = this.strokePoints[this.strokePoints.length - 1];
      const mode = this.erasing ? "erase" : "draw";
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const dist = Math.hypot(dx, dy);
      const step = Math.max(0.5, this.radius * 0.5);
      const n = Math.max(1, Math.ceil(dist / step));
      for (let i = 1; i <= n; i += 1) {
        const t = i / n;
        const x = a[0] + dx * t;
        const y = a[1] + dy * t;
        this.rasterizer.paintBrushHardness(x, y, this.radius, this.hardness, mode);
      }
    }
  }

  onPointerUp(_p: Point): void {
    this.painting = false;
    this.strokePoints = [];
  }

  onKeyDown(key: string): { committed: boolean; cancelled: boolean } {
    if (key === "Enter") {
      const ok = this.commit();
      return { committed: ok, cancelled: false };
    }
    if (key === "Escape") {
      this.cancel();
      return { committed: false, cancelled: true };
    }
    if (key === "[") {
      this.bumpRadius(-RADIUS_STEP_PX);
      return { committed: false, cancelled: false };
    }
    if (key === "]") {
      this.bumpRadius(RADIUS_STEP_PX);
      return { committed: false, cancelled: false };
    }
    return { committed: false, cancelled: false };
  }

  cancel(): void {
    this.rasterizer?.clear();
    this.rasterizer = null;
    this.painting = false;
    this.strokePoints = [];
  }

  private commit(): boolean {
    if (!this.rasterizer) return false;
    const classId = this.getActiveClassId();
    if (!classId) {
      this.cancel();
      return false;
    }
    if (!this.rasterizer.hasAnyPixel()) {
      this.cancel();
      return false;
    }
    const { counts, size } = this.rasterizer.encodeRLE();
    useAnnotations.getState().add({
      tempId: this.generateTempId(),
      classId,
      kind: "mask",
      geometry: { kind: "mask_rle", size, counts },
      frameId: this.getFrameId(),
      serverId: null,
      dirty: true,
    });
    this.rasterizer = null;
    this.painting = false;
    this.strokePoints = [];
    return true;
  }
}

function clampRadius(r: number): number {
  if (!Number.isFinite(r)) return DEFAULT_RADIUS;
  return Math.max(MIN_RADIUS, Math.min(MAX_RADIUS, Math.round(r)));
}
