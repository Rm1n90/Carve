import { useAnnotations } from "@/state/annotations";
import type { Point } from "./BboxTool";
import { encodeRLE } from "@/canvas/maskio";

const DEFAULT_RADIUS = 12;

export class MaskBrushTool {
  private mask: Uint8Array | null = null;
  private painting = false;
  private erasing = false;

  constructor(
    private getActiveClassId: () => string | null,
    private getFrameId: () => string | null,
    private getImageSize: () => { w: number; h: number },
    private radius: number = DEFAULT_RADIUS,
    private generateTempId: () => string = () => `t-${Math.random().toString(36).slice(2)}`,
  ) {}

  setEraser(on: boolean): void { this.erasing = on; }

  onPointerDown(p: Point): void {
    if (!this.mask) {
      const { w, h } = this.getImageSize();
      this.mask = new Uint8Array(w * h);
    }
    this.painting = true;
    this.paintAt(p);
  }

  onPointerMove(p: Point): void {
    if (this.painting) this.paintAt(p);
  }

  onPointerUp(_p: Point): void {
    this.painting = false;
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
    this.mask = null;
    this.painting = false;
  }

  private paintAt(p: Point): void {
    if (!this.mask) return;
    const { w, h } = this.getImageSize();
    const r = this.radius;
    const r2 = r * r;
    const x0 = Math.max(0, Math.floor(p.x - r));
    const y0 = Math.max(0, Math.floor(p.y - r));
    const x1 = Math.min(w - 1, Math.floor(p.x + r));
    const y1 = Math.min(h - 1, Math.floor(p.y + r));
    const v = this.erasing ? 0 : 1;
    for (let y = y0; y <= y1; y += 1) {
      for (let x = x0; x <= x1; x += 1) {
        const dx = x - p.x;
        const dy = y - p.y;
        if (dx * dx + dy * dy <= r2) {
          this.mask[y * w + x] = v;
        }
      }
    }
  }

  private commit(): boolean {
    if (!this.mask) return false;
    const classId = this.getActiveClassId();
    if (!classId) {
      this.cancel();
      return false;
    }
    const { w, h } = this.getImageSize();
    const counts = encodeRLE(this.mask, h, w);
    useAnnotations.getState().add({
      tempId: this.generateTempId(),
      classId,
      kind: "mask",
      geometry: { kind: "mask_rle", size: [h, w], counts },
      frameId: this.getFrameId(),
      serverId: null,
      dirty: true,
    });
    this.mask = null;
    return true;
  }
}
