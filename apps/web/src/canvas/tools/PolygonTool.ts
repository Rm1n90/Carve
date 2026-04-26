import { useAnnotations } from "@/state/annotations";
import type { Point } from "./BboxTool";

const CLOSE_RADIUS_PX = 8;

export class PolygonTool {
  private vertices: Point[] = [];

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
    return true;
  }
}
