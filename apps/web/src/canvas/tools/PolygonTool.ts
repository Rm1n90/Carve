import { useAnnotations } from "@/state/annotations";
import { showToast } from "@/lib/toast";
import type { Point } from "./BboxTool";

/**
 * Distance (image-space px) at which clicking near the first vertex closes
 * an in-progress polygon. Exported so the canvas preview can highlight the
 * first vertex when the cursor is within this radius.
 */
export const CLOSE_RADIUS_PX = 12;

export class PolygonTool {
  private vertices: Point[] = [];
  private cursor: Point | null = null;

  constructor(
    private getActiveClassId: () => string | null,
    private getFrameId: () => string | null,
    private generateTempId: () => string = () => `t-${Math.random().toString(36).slice(2)}`,
  ) {}

  onPointerDown(p: Point): { committed: boolean } {
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
    useAnnotations.getState().add({
      tempId: this.generateTempId(),
      classId,
      kind: "polygon",
      geometry: {
        kind: "polygon",
        points: this.vertices.map((v) => [v.x, v.y]),
      },
      frameId: this.getFrameId(),
      serverId: null,
      dirty: true,
    });
    this.vertices = [];
    this.cursor = null;
    return true;
  }
}
