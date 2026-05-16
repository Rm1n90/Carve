// Armin Mehri — mehri.armin@gmail.com
import { useAnnotations } from "@/state/annotations";
import { useTool } from "@/state/tool";
import { showToast } from "@/lib/toast";
import type { ImageSize, Point } from "./BboxTool";

/**
 * Distance (image-space px) at which clicking near the first vertex closes
 * an in-progress polygon. Exported so the canvas preview can highlight the
 * first vertex when the cursor is within this radius.
 */
export const CLOSE_RADIUS_PX = 12;

function clamp(value: number, lo: number, hi: number): number {
  if (value < lo) return lo;
  if (value > hi) return hi;
  return value;
}

export class PolygonTool {
  private vertices: Point[] = [];
  private cursor: Point | null = null;
  private imageSize: ImageSize | null = null;

  constructor(
    private getActiveClassId: () => string | null,
    private getFrameId: () => string | null,
    private generateTempId: () => string = () => `t-${Math.random().toString(36).slice(2)}`,
    /**
     * Optional accessor for the image size. Lives behind a getter so the
     * tool re-reads on every event — the canvas's `imageSize` ref updates
     * when a new asset's texture finishes loading.
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

  onPointerDown(p: Point): { committed: boolean } {
    // v3.24.13 — vertices are stored at the raw cursor so the user can
    // drop points outside the image. Each vertex is clamped to the
    // image boundary inside `commit()` on close.
    // Click on first vertex closes polygon when >= 3 vertices placed
    if (this.vertices.length >= 3) {
      const first = this.vertices[0];
      const dx = p.x - first.x;
      const dy = p.y - first.y;
      if (dx * dx + dy * dy <= CLOSE_RADIUS_PX * CLOSE_RADIUS_PX) {
        this.commit();
        return { committed: true };
      }
    }
    this.vertices.push(p);
    return { committed: false };
  }

  /**
   * Track the cursor position so the canvas can draw the rubber-band
   * segment from the last placed vertex. Returns a snapshot of the in-flight
   * polygon for the renderer.
   */
  onPointerMove(p: Point): {
    vertices: readonly Point[];
    cursor: Point;
    closeHint: boolean;
  } | null {
    if (this.vertices.length === 0) return null;
    // v3.24.13 — preview cursor follows raw input so the rubber-band
    // segment can extend past the image edge during draw.
    this.cursor = p;
    let closeHint = false;
    if (this.vertices.length >= 3) {
      const first = this.vertices[0];
      const dx = p.x - first.x;
      const dy = p.y - first.y;
      closeHint = dx * dx + dy * dy <= CLOSE_RADIUS_PX * CLOSE_RADIUS_PX;
    }
    return { vertices: this.vertices, cursor: p, closeHint };
  }

  /** Most recent cursor position (used by the live preview). */
  cursorPosition(): Point | null {
    return this.cursor;
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
    return { committed: false, cancelled: false };
  }

  cancel(): void {
    this.vertices = [];
    this.cursor = null;
  }

  vertexCount(): number {
    return this.vertices.length;
  }

  preview(): readonly Point[] {
    return this.vertices;
  }

  private commit(): boolean {
    if (this.vertices.length < 3) {
      return false;
    }
    const classId = this.getActiveClassId();
    if (!classId) {
      // Surface a toast so the user understands why the commit was dropped.
      showToast("Pick a class first", { variant: "warning" });
      this.cancel();
      return false;
    }
    // v3.24.13 — clamp every vertex to the image boundary on commit. The
    // draw itself ran on raw cursor positions so the user could place
    // vertices outside the frame; on release the polygon snaps to the
    // image edges so the persisted geometry stays inside.
    const size = this.resolveImageSize();
    const points = this.vertices.map(
      (v) =>
        size
          ? ([clamp(v.x, 0, size.w), clamp(v.y, 0, size.h)] as [number, number])
          : ([v.x, v.y] as [number, number]),
    );
    useAnnotations.getState().add({
      tempId: this.generateTempId(),
      classId,
      kind: "polygon",
      geometry: {
        kind: "polygon",
        points,
      },
      frameId: this.getFrameId(),
      serverId: null,
      dirty: true,
    });
    // F4 — record tool-driven draw for streak.
    useTool.getState().recordDraw(classId);
    this.vertices = [];
    this.cursor = null;
    return true;
  }
}
