import { useAnnotations } from "@/state/annotations";

export interface Point {
  x: number;
  y: number;
}

const MIN_DRAG_PX = 4;

export class BboxTool {
  private anchor: Point | null = null;
  private current: Point | null = null;

  constructor(
    private getActiveClassId: () => string | null,
    private getFrameId: () => string | null,
    private generateTempId: () => string = () => `t-${Math.random().toString(36).slice(2)}`,
  ) {}

  onPointerDown(p: Point): void {
    this.anchor = p;
    this.current = p;
  }

  onPointerMove(p: Point): { preview: { x: number; y: number; w: number; h: number } } | null {
    if (!this.anchor) return null;
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
    if (distSq < MIN_DRAG_PX * MIN_DRAG_PX || !classId) {
      this.reset();
      return false;
    }
    const x = Math.min(this.anchor.x, p.x);
    const y = Math.min(this.anchor.y, p.y);
    const w = Math.abs(dx);
    const h = Math.abs(dy);
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
