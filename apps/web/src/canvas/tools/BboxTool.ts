// Armin Mehri — mehri.armin@gmail.com
import { useAnnotations } from "@/state/annotations";
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

/**
 * Clamp a point to the image bounds. When `size` is null we leave the
 * point untouched — the tool then falls back to the bound-agnostic path
 * used before v2.5.2.
 */
function clampToImage(p: Point, size: ImageSize | null): Point {
  if (!size) return p;
  return {
    x: clamp(p.x, 0, size.w),
    y: clamp(p.y, 0, size.h),
  };
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
    const clamped = clampToImage(p, this.resolveImageSize());
    this.anchor = clamped;
    this.current = clamped;
  }

  onPointerMove(p: Point): { preview: { x: number; y: number; w: number; h: number } } | null {
    if (!this.anchor) return null;
    const clamped = clampToImage(p, this.resolveImageSize());
    this.current = clamped;
    const x = Math.min(this.anchor.x, clamped.x);
    const y = Math.min(this.anchor.y, clamped.y);
    const w = Math.abs(this.anchor.x - clamped.x);
    const h = Math.abs(this.anchor.y - clamped.y);
    return { preview: { x, y, w, h } };
  }

  onPointerUp(p: Point): boolean {
    if (!this.anchor) return false;
    const clamped = clampToImage(p, this.resolveImageSize());
    const dx = clamped.x - this.anchor.x;
    const dy = clamped.y - this.anchor.y;
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
    const x = Math.min(this.anchor.x, clamped.x);
    const y = Math.min(this.anchor.y, clamped.y);
    const w = Math.abs(dx);
    const h = Math.abs(dy);
    // After clamping, the rectangle may have collapsed (e.g. user dragged
    // entirely outside the image). Reject anything below the minimum edge
    // size so we never store a degenerate / off-topic geometry. v2.5.2.
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
