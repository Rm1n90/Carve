import { useAnnotations } from "@/state/annotations";
import { samApi, type SamDecodeResult, type SamPromptResult } from "@/api/sam";
import { canDecodeLocally } from "@/canvas/sam/onnx";
import type { Point } from "./BboxTool";

/**
 * v3.5 Phase D/E — four input modalities for SAM:
 *
 *   point — click-driven, SAM 2 / SAM 3 (via /sam/encode + /sam/decode).
 *   box   — drag a rectangle, SAM 3 only (via /sam/box-prompt).
 *   text  — type an object name, SAM 3 only (via /sam/text-prompt).
 *   track — multi-frame video tracking, SAM 2 + SAM 3 (via /sam-track/*).
 *           The track flow lives in <SamTrackPanel> + TrackPropagateTool
 *           rather than this class; SamMode merely advertises it so the
 *           toolbar mode picker and the editor right rail know to swap
 *           in the dedicated panel.
 *
 * The legacy point flow is preserved verbatim. Box and text modes are
 * one-shot (no session / encode round-trip) — each call sends the
 * asset's bytes through the API proxy. The audit explicitly chose ONE
 * tool with a mode field over three classes so the canvas wiring,
 * keyboard handling, and commit semantics stay unified.
 */
export type SamMode = "point" | "box" | "text" | "track";

export type SamBox = [number, number, number, number];

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
  private mode: SamMode = "point";
  private imageHash: string | null = null;
  private positives: [number, number][] = [];
  private negatives: [number, number][] = [];
  private boxes: SamBox[] = [];
  private text = "";
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
    // Point mode requires a cached image_hash from /sam/encode. Box and
    // text modes are one-shot (no encode), so they're "ready" the
    // moment the asset id is known — i.e. always for the lifetime of
    // the tool.
    if (this.mode !== "point") return true;
    return this.imageHash !== null;
  }

  /** Current input modality. */
  getMode(): SamMode {
    return this.mode;
  }

  /**
   * Switch the active modality. Resets all in-flight state so a click
   * accumulated under the old mode doesn't bleed into the new one
   * (e.g. switching from point→box must drop accumulated points).
   */
  setMode(mode: SamMode): void {
    if (this.mode === mode) return;
    this.mode = mode;
    this.positives = [];
    this.negatives = [];
    this.boxes = [];
    this.text = "";
    this.lastResult = null;
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
    this.boxes = [];
    this.text = "";
    this.lastResult = null;
  }

  /**
   * Box mode entry point. Stores ``box`` (xyxy image-space) and runs a
   * single /sam/box-prompt call. Returns the best mask candidate, or
   * ``null`` when the model service returns no candidates / the wrong
   * mode is active. Errors propagate so the caller can render a toast.
   */
  async setBox(box: SamBox): Promise<SamPromptResult | null> {
    if (this.mode !== "box") return null;
    this.boxes = [box];
    const results = await samApi.boxPrompt(this.assetId, this.boxes, [1]);
    return this.applyPromptResult(results);
  }

  /**
   * Text mode entry point. Stores ``text`` and runs a single
   * /sam/text-prompt call. Returns the best mask candidate.
   */
  async setText(text: string): Promise<SamPromptResult | null> {
    if (this.mode !== "text") return null;
    const trimmed = text.trim();
    if (trimmed.length === 0) {
      this.text = "";
      this.lastResult = null;
      return null;
    }
    this.text = trimmed;
    const results = await samApi.textPrompt(this.assetId, this.text);
    return this.applyPromptResult(results);
  }

  /**
   * Pick the best (highest-score) mask candidate and stash it on
   * ``lastResult`` so ``commit()`` can write it as an annotation.
   * The point flow's ``lastResult`` shape is the same {counts, size,
   * score} so commit is shared across all three modes.
   */
  private applyPromptResult(results: SamPromptResult[]): SamPromptResult | null {
    if (results.length === 0) {
      this.lastResult = null;
      return null;
    }
    let best = results[0];
    for (const r of results) {
      if (r.score > best.score) best = r;
    }
    this.lastResult = {
      counts: best.counts,
      size: best.size,
      score: best.score,
    };
    return best;
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
