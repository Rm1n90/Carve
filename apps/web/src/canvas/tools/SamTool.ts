import { useAnnotations } from "@/state/annotations";
import { samApi, type SamDecodeResult } from "@/api/sam";
import type { Point } from "./BboxTool";

interface ToolButton {
  pointer: number; // 0=left, 2=right
}

/**
 * Click-driven SAM tool.
 *
 * Activation calls /sam/encode once and caches the image_hash. Each click
 * sends accumulated (points, labels) to /sam/decode. Left click adds a
 * positive point (label=1); right click adds a negative point (label=0).
 * `commit()` (Enter) writes the current best mask as a `mask` annotation.
 */
export class SamTool {
  private imageHash: string | null = null;
  private positives: [number, number][] = [];
  private negatives: [number, number][] = [];
  private lastResult: SamDecodeResult | null = null;
  private encoding = false;

  constructor(
    private assetId: string,
    private getActiveClassId: () => string | null,
    private getFrameId: () => string | null,
    private generateTempId: () => string = () =>
      `t-${Math.random().toString(36).slice(2)}`,
  ) {}

  isReady(): boolean {
    return this.imageHash !== null;
  }

  async activate(): Promise<void> {
    if (this.imageHash !== null || this.encoding) return;
    this.encoding = true;
    try {
      const enc = await samApi.encode(this.assetId);
      this.imageHash = enc.image_hash;
    } finally {
      this.encoding = false;
    }
  }

  reset(): void {
    this.positives = [];
    this.negatives = [];
    this.lastResult = null;
  }

  /** Add a point and refresh the mask. Returns the latest decode result. */
  async addClick(p: Point, button: ToolButton): Promise<SamDecodeResult | null> {
    if (this.imageHash === null) return null;
    if (button.pointer === 2) {
      this.negatives.push([Math.round(p.x), Math.round(p.y)]);
    } else {
      this.positives.push([Math.round(p.x), Math.round(p.y)]);
    }
    const points: [number, number][] = [...this.positives, ...this.negatives];
    const labels = [
      ...this.positives.map(() => 1),
      ...this.negatives.map(() => 0),
    ];
    if (points.length === 0) {
      this.lastResult = null;
      return null;
    }
    this.lastResult = await samApi.decode(this.assetId, this.imageHash, points, labels);
    return this.lastResult;
  }

  /** Commit the current best mask as a mask annotation. Returns true if committed. */
  commit(): boolean {
    if (!this.lastResult) return false;
    const classId = this.getActiveClassId();
    if (!classId) return false;
    useAnnotations.getState().add({
      tempId: this.generateTempId(),
      classId,
      kind: "mask",
      geometry: {
        kind: "mask_rle",
        size: this.lastResult.size,
        counts: this.lastResult.counts,
      },
      frameId: this.getFrameId(),
      serverId: null,
      dirty: true,
    });
    this.reset();
    return true;
  }
}
