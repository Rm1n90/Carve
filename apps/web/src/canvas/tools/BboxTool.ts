// Armin Mehri — mehri.armin@gmail.com
import { useAnnotations } from "@/state/annotations";
import { useTool } from "@/state/tool";
import { showToast } from "@/lib/toast";

export interface Point {
  x: number;
  y: number;
}

/**
 * Optional image bounds. Tools clamp anchor + cursor to these dimensions
 * so the recorded geometry can never escape the underlying image — the
 * user can drag past the canvas backdrop without the bbox following.
 *
 * `null` means "unknown size" (e.g. the image hasn't loaded yet); in that
 * mode the tool falls back to the legacy bound-agnostic behaviour. v2.5.2.
 */
export interface ImageSize {
  w: number;
  h: number;
}

/**
 * Minimum drag distance (image-space px) below which a pointerdown ->
 * pointerup is treated as noise and silently dropped.
 */
const MIN_DRAG_PX = 4;

/**
 * Minimum bbox edge size (image-space px). Mirrors `MIN_BBOX_SIZE` in
 * `bboxEdit.ts` so a draw + a resize land on the same lower bound.
 *
 * Why repeat the constant here rather than import? Tools live in their
 * own folder and we want to keep the dependency graph one-way (canvas/tools
 * does not import from canvas/). The value is small and stable.
 */
const MIN_BBOX_SIZE = 4;

function clamp(value: number, lo: number, hi: number): number {
  if (value < lo) return lo;
  if (value > hi) return hi;
  return value;
}

export class BboxTool {
  private anchor: Point | null = null;
  private current: Point | null = null;
  private imageSize: ImageSize | null = null;

  constructor(
    private getActiveClassId: () => string | null,
    private getFrameId: () => string | null,
    private generateTempId: () => string = () => `t-${Math.random().toString(36).slice(2)}`,
    /**
     * Optional accessor for the image size. The canvas owns the live
     * `imageSize` ref; passing it as a getter rather than a value keeps
     * the tool reactive to texture loads without recreating it.
     */
    private getImageSize: () => ImageSize | null = () => null,
  ) {}

  /** Used by tests + AnnotationCanvas to push a fresh size mid-life. */
  setImageSize(size: ImageSize | null): void {
    this.imageSize = size;
  }

  private resolveImageSize(): ImageSize | null {
    if (this.imageSize) return this.imageSize;
    return this.getImageSize();
  }

  onPointerDown(p: Point): void {
    // v3.24.13 — anchor stays at the raw cursor (no clamp) so the user
    // can begin a draw outside the image. The geometry is clamped to
    // the image only on commit, in onPointerUp.
    this.anchor = p;
    this.current = p;
  }

  onPointerMove(p: Point): { preview: { x: number; y: number; w: number; h: number } } | null {
    if (!this.anchor) return null;
    // v3.24.13 — render the live preview at the raw cursor so the user
    // sees the rectangle they're drawing even when the cursor is
    // outside the image. The clamp lands on commit (onPointerUp).
    this.current = p;
    const x = Math.min(this.anchor.x, p.x);
    const y = Math.min(this.anchor.y, p.y);
    const w = Math.abs(this.anchor.x - p.x);
    const h = Math.abs(this.anchor.y - p.y);
    return { preview: { x, y, w, h } };
  }

  onPointerUp(p: Point): boolean {
    if (!this.anchor) return false;
    const dx = p.x - this.anchor.x;
    const dy = p.y - this.anchor.y;
    const distSq = dx * dx + dy * dy;
    const classId = this.getActiveClassId();
    // Tiny drags are noise — silently discard.
    if (distSq < MIN_DRAG_PX * MIN_DRAG_PX) {
      this.reset();
      return false;
    }
    // Real drag but no active class — surface a toast so the user understands
    // why nothing was created. Audit bug 1+I.
    if (!classId) {
      showToast("Pick a class first", { variant: "warning" });
      this.reset();
      return false;
    }
    // v3.24.13 — clamp the final rect to the image on commit. The rest
    // of the draw (anchor + live preview) ran on raw cursor coordinates
    // so the user can extend past the image edge and the rectangle
    // snaps to the boundary on release.
    const rawX = Math.min(this.anchor.x, p.x);
    const rawY = Math.min(this.anchor.y, p.y);
    const rawW = Math.abs(dx);
    const rawH = Math.abs(dy);
    const size = this.resolveImageSize();
    let x = rawX;
    let y = rawY;
    let w = rawW;
    let h = rawH;
    if (size) {
      const x1 = clamp(rawX, 0, size.w);
      const y1 = clamp(rawY, 0, size.h);
      const x2 = clamp(rawX + rawW, 0, size.w);
      const y2 = clamp(rawY + rawH, 0, size.h);
      x = x1;
      y = y1;
      w = x2 - x1;
      h = y2 - y1;
    }
    // After clamping, the rectangle may have collapsed (e.g. user dragged
    // entirely outside the image). Reject anything below the minimum edge
    // size so we never store a degenerate / off-topic geometry.
    if (w < MIN_BBOX_SIZE || h < MIN_BBOX_SIZE) {
      this.reset();
      return false;
    }
    useAnnotations.getState().add({
      tempId: this.generateTempId(),
      classId,
      kind: "bbox",
      geometry: { kind: "bbox", x, y, w, h },
      frameId: this.getFrameId(),
      serverId: null,
      dirty: true,
    });
    // F4 — record this as a tool-driven draw so the streak indicator
    // can show "5× Car in a row". Programmatic adds (paste, copy-from-
    // previous, SAM batch, YOLO predict) intentionally skip this call.
    useTool.getState().recordDraw(classId);
    this.reset();
    return true;
  }

  cancel(): void {
    this.reset();
  }

  private reset(): void {
    this.anchor = null;
    this.current = null;
  }
}
