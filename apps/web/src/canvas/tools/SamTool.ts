import { useAnnotations } from "@/state/annotations";
import { samApi, type SamDecodeResult } from "@/api/sam";
import { canDecodeLocally } from "@/canvas/sam/onnx";
import type { Point } from "./BboxTool";

interface ToolButton {
  pointer: number; // 0=left, 2=right
}

/** Optional UI hook fired when SamTool auto-recovers from a 409. */
export type SamResyncNotifier = (message: string) => void;

/**
 * Read the HTTP status code off a thrown decode error.
 *
 * Axios surfaces failures as ``AxiosError`` with ``response.status`` —
 * we treat anything else as "no status" (returns ``null``) so the
 * retry path is opt-in to genuine server responses, not network
 * faults / cancellation / programmer errors.
 */
function getStatusCode(err: unknown): number | null {
  if (typeof err !== "object" || err === null) return null;
  const e = err as { response?: { status?: unknown }; status?: unknown };
  if (e.response && typeof e.response.status === "number") return e.response.status;
  if (typeof e.status === "number") return e.status;
  return null;
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
  // Readiness signal for the in-browser ONNX decoder. Becomes `true` only
  // when (a) the model service exposed `embedding_b64` AND (b) the
  // browser supports WebGPU AND (c) the operator-provisioned ONNX model
  // file is reachable. v1 always falls through to server-side decode;
  // v1.1 will branch on this flag inside `addClick`.
  private localDecodeReady = false;

  constructor(
    private assetId: string,
    private getActiveClassId: () => string | null,
    private getFrameId: () => string | null,
    private generateTempId: () => string = () =>
      `t-${Math.random().toString(36).slice(2)}`,
    private onResync: SamResyncNotifier | null = null,
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
      // Best-effort probe — never let the readiness check block activation.
      if (enc.embedding_b64) {
        try {
          this.localDecodeReady = await canDecodeLocally();
        } catch {
          this.localDecodeReady = false;
        }
      }
    } finally {
      this.encoding = false;
    }
  }

  /**
   * Force a re-encode by clearing the cached image_hash and calling
   * ``activate()`` again. Used on a 409 from ``/sam/decode`` so the
   * model worker re-runs ``set_image`` for the current asset.
   */
  private async reencode(): Promise<void> {
    this.imageHash = null;
    await this.activate();
  }

  /** v1.1 hook: returns whether a local in-browser decode is provisioned. */
  isLocalDecodeReady(): boolean {
    return this.localDecodeReady;
  }

  reset(): void {
    this.positives = [];
    this.negatives = [];
    this.lastResult = null;
  }

  /**
   * Add a point and refresh the mask. Returns the latest decode result.
   *
   * v3.5 Phase A3: if the server returns 409 (the model worker's
   * ``embedding_not_loaded`` gate — typically because the predictor
   * was evicted, the variant was switched, or the worker restarted
   * since the last encode), automatically re-encode the asset and
   * retry the decode ONCE. The re-sync notifier (passed at
   * construction) is invoked so the UI can flash a "Re-syncing SAM"
   * toast. If the retry also fails, the error is re-thrown for the
   * caller's normal error handling.
   */
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

    try {
      this.lastResult = await samApi.decode(
        this.assetId,
        this.imageHash,
        points,
        labels,
      );
      return this.lastResult;
    } catch (err) {
      const status = getStatusCode(err);
      if (status !== 409) throw err;
      // 409 = the model worker no longer has this image's embedding.
      // Notify the UI, re-encode, and retry the decode once.
      this.onResync?.("Re-syncing SAM — try again");
      await this.reencode();
      if (this.imageHash === null) {
        // Re-encode failed (network error, etc.) — bubble the
        // original 409 so the caller sees a consistent error path.
        throw err;
      }
      this.lastResult = await samApi.decode(
        this.assetId,
        this.imageHash,
        points,
        labels,
      );
      return this.lastResult;
    }
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
