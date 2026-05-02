// Armin Mehri — mehri.armin@gmail.com
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
  // v3.8 Phase 4-video step F4 — track which frame the imageHash was
  // encoded for so we can invalidate on frame change.
  private encodedFrameId: string | null = null;
  private positives: [number, number][] = [];
  private negatives: [number, number][] = [];
  // v3.8 Phase 1 — insertion order so Backspace can pop the most
  // recently added click regardless of polarity. Lengths satisfy
  // clickOrder.length === positives.length + negatives.length.
  private clickOrder: ("p" | "n")[] = [];
  private boxes: SamBox[] = [];
  private text = "";
  private lastResult: SamDecodeResult | null = null;
  private encoding = false;
  // v3.8 Phase 1 — abort the previous in-flight decode when a new
  // click lands so out-of-order responses cannot paint a stale mask.
  private inFlight: AbortController | null = null;
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
    // v3.8 Phase 2 — Point AND Box modes both go through /sam/encode +
    // /sam/decode now (box-then-refine reuses the embedding cache).
    // Text mode remains one-shot through /sam/text-prompt.
    if (this.mode === "text") return true;
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
    this.clickOrder = [];
    this.boxes = [];
    this.text = "";
    this.lastResult = null;
    this.inFlight?.abort();
    this.inFlight = null;
  }

  async activate(): Promise<void> {
    const currentFrame = this.getFrameId();
    // v3.8 Phase 4-video step F4 — re-encode when the user has
    // scrubbed to a different frame; the previously-cached image_hash
    // belongs to a stale frame's pixels.
    if (
      this.imageHash !== null &&
      this.encodedFrameId === currentFrame &&
      !this.encoding
    ) {
      return;
    }
    if (this.encoding) return;
    this.imageHash = null;
    this.encoding = true;
    try {
      const enc = await samApi.encode(this.assetId, currentFrame);
      this.imageHash = enc.image_hash;
      this.encodedFrameId = currentFrame;
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
    this.clickOrder = [];
    this.boxes = [];
    this.text = "";
    this.lastResult = null;
    this.inFlight?.abort();
    this.inFlight = null;
  }

  /**
   * Pop the most recently added click (positive or negative) and re-run
   * decode against the remaining points. Returns the new decode result,
   * or ``null`` when no clicks remain (caller should clear the preview).
   * v3.8 Phase 1.
   */
  async popLastClick(): Promise<SamDecodeResult | null> {
    const last = this.clickOrder.pop();
    if (last === undefined) return null;
    if (last === "p") this.positives.pop();
    else this.negatives.pop();
    if (this.imageHash === null) return null;
    const points: [number, number][] = [...this.positives, ...this.negatives];
    const box = this.boxes.length > 0 ? this.boxes[0] : null;
    // v3.8 Phase 2 — when only the box remains (all clicks popped), keep
    // the box-anchored mask alive instead of clearing the preview.
    if (points.length === 0 && box === null) {
      this.lastResult = null;
      this.inFlight?.abort();
      this.inFlight = null;
      return null;
    }
    const labels = [
      ...this.positives.map(() => 1),
      ...this.negatives.map(() => 0),
    ];
    this.inFlight?.abort();
    const ac = new AbortController();
    this.inFlight = ac;
    try {
      const result = await samApi.decode(
        this.assetId,
        this.imageHash,
        points,
        labels,
        ac.signal,
        box,
      );
      if (ac.signal.aborted) return this.lastResult;
      this.lastResult = result;
      return result;
    } catch (err) {
      if (ac.signal.aborted) return this.lastResult;
      throw err;
    } finally {
      if (this.inFlight === ac) this.inFlight = null;
    }
  }

  /**
   * Read-only views of the click prompts accumulated so far. The canvas
   * uses these to paint per-click markers (green=positive, red=negative)
   * directly on the overlay layer — without these accessors the canvas
   * would have to mirror the same coordinate-rounding logic this class
   * already runs in addClick. v3.6 SAM live preview.
   */
  getPositives(): ReadonlyArray<readonly [number, number]> {
    return this.positives;
  }

  getNegatives(): ReadonlyArray<readonly [number, number]> {
    return this.negatives;
  }

  /**
   * Read-only view of the latest decode/prompt result so the canvas can
   * paint a live mask preview before the user commits. Mirrors the
   * shape of SamDecodeResult but typed as a generic mask payload to
   * keep callers decoupled from the exact result class. v3.6.
   */
  getLastResult(): SamDecodeResult | null {
    return this.lastResult;
  }

  /**
   * Box mode entry point. v3.8 Phase 2 — routes through /sam/decode
   * with ``box`` and the embedding cache instead of the SAM 3-only
   * /sam/box-prompt one-shot. The cached box stays attached so any
   * later ``addClick`` refines the same candidate without re-uploading
   * the image bytes. Caller must have ``activate()``-ed the tool first
   * (same encode contract as Point mode).
   *
   * Returns the decode result (with polygon for editable commit) or
   * ``null`` when the wrong mode is active or the tool is not ready.
   */
  async setBox(box: SamBox): Promise<SamDecodeResult | null> {
    if (this.mode !== "box") return null;
    if (this.imageHash === null) return null;
    this.boxes = [box];
    // Box-only decode: no points, no labels.
    this.positives = [];
    this.negatives = [];
    this.clickOrder = [];
    this.inFlight?.abort();
    const ac = new AbortController();
    this.inFlight = ac;
    try {
      const result = await samApi.decode(
        this.assetId,
        this.imageHash,
        [],
        [],
        ac.signal,
        box,
      );
      if (ac.signal.aborted) return this.lastResult;
      this.lastResult = result;
      return result;
    } catch (err) {
      if (ac.signal.aborted) return this.lastResult;
      const status = getStatusCode(err);
      if (status !== 409) throw err;
      this.onResync?.("Re-syncing SAM — try again");
      await this.reencode();
      if (this.imageHash === null) throw err;
      const retry = await samApi.decode(
        this.assetId,
        this.imageHash,
        [],
        [],
        ac.signal,
        box,
      );
      if (ac.signal.aborted) return this.lastResult;
      this.lastResult = retry;
      return retry;
    } finally {
      if (this.inFlight === ac) this.inFlight = null;
    }
  }

  /** v3.8 Phase 2 — read the cached box (or null when no box is active). */
  getBox(): SamBox | null {
    return this.boxes.length > 0 ? this.boxes[0] : null;
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
    const results = await samApi.textPrompt(
      this.assetId,
      this.text,
      this.getFrameId(),
    );
    return this.applyPromptResult(results);
  }

  /**
   * v3.8 Phase 3.7 — Text mode "Find all" entry point. Calls
   * /sam/text-prompt, filters by score threshold, and commits every
   * surviving candidate as a polygon (or mask fallback) annotation
   * under ``classId``. No preview dance: results land directly so
   * the user can see all instances and tweak from there.
   *
   * Returns ``{ created: N, total: M }`` where M is the raw candidate
   * count from the model service and N is what survived the threshold
   * filter and was committed. Throws upstream errors verbatim so the
   * caller can render the standard SAM error toast.
   */
  async applyTextMulti(
    text: string,
    threshold: number,
    classId: string,
  ): Promise<{ created: number; total: number }> {
    if (this.mode !== "text") return { created: 0, total: 0 };
    const trimmed = text.trim();
    if (trimmed.length === 0) return { created: 0, total: 0 };
    this.text = trimmed;
    const results = await samApi.textPrompt(
      this.assetId,
      this.text,
      this.getFrameId(),
    );
    const total = results.length;
    const kept = results.filter((r) => r.score >= threshold);
    const frameId = this.getFrameId();
    let created = 0;
    for (const r of kept) {
      const polygon = r.polygon;
      if (polygon && polygon.length >= 3) {
        useAnnotations.getState().add({
          tempId: this.generateTempId(),
          classId,
          kind: "polygon",
          geometry: { kind: "polygon", points: polygon },
          frameId,
          serverId: null,
          dirty: true,
        });
      } else {
        useAnnotations.getState().add({
          tempId: this.generateTempId(),
          classId,
          kind: "mask",
          geometry: {
            kind: "mask_rle",
            size: r.size,
            counts: r.counts,
          },
          frameId,
          serverId: null,
          dirty: true,
        });
      }
      created += 1;
    }
    // Don't stash a preview: in multi-mode results are already
    // committed, so leaving lastResult set would let a stray Enter
    // press re-commit one as a duplicate.
    this.lastResult = null;
    return { created, total };
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
      // v3.8 Phase 1 — preserve polygon when the SAM 3 factory emitted
      // one. Defaults to [] when the upstream payload omits the field
      // (legacy factories), in which case commit() falls back to mask.
      polygon: best.polygon ?? [],
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
      this.clickOrder.push("n");
    } else {
      this.positives.push([Math.round(p.x), Math.round(p.y)]);
      this.clickOrder.push("p");
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

    // v3.8 Phase 1 — abort any in-flight decode for an older click so
    // out-of-order responses cannot paint a stale mask on top of a
    // newer one. The aborted call resolves to ``aborted=true`` and is
    // silently ignored below.
    this.inFlight?.abort();
    const ac = new AbortController();
    this.inFlight = ac;

    // v3.8 Phase 2 — include the cached box (if any) so a click after
    // setBox refines the same box-anchored mask.
    const box = this.boxes.length > 0 ? this.boxes[0] : null;

    try {
      const result = await samApi.decode(
        this.assetId,
        this.imageHash,
        points,
        labels,
        ac.signal,
        box,
      );
      if (ac.signal.aborted) return this.lastResult;
      this.lastResult = result;
      return result;
    } catch (err) {
      if (ac.signal.aborted) return this.lastResult;
      const status = getStatusCode(err);
      if (status !== 409) throw err;
      // 409 = the model worker no longer has this image's embedding.
      // Notify the UI, re-encode, and retry the decode once.
      this.onResync?.("Re-syncing SAM — try again");
      await this.reencode();
      if (this.imageHash === null) {
        throw err;
      }
      const retry = await samApi.decode(
        this.assetId,
        this.imageHash,
        points,
        labels,
        ac.signal,
        box,
      );
      if (ac.signal.aborted) return this.lastResult;
      this.lastResult = retry;
      return retry;
    } finally {
      if (this.inFlight === ac) this.inFlight = null;
    }
  }

  /**
   * Commit the current best result. v3.8 Phase 1 — emits a ``polygon``
   * annotation when the decode produced a usable contour (>=3 vertices)
   * so the result is immediately editable via the existing polygon
   * vertex-edit machinery. Falls back to a ``mask_rle`` annotation when
   * the polygon is empty (e.g. SAM 3 factories that haven't been
   * updated, or degenerate single-pixel masks).
   *
   * Returns true if committed. Uses the active class from useTool unless
   * ``classId`` is supplied (digit shortcut path).
   */
  commit(classId?: string): boolean {
    if (!this.lastResult) return false;
    const cls = classId ?? this.getActiveClassId();
    if (!cls) return false;
    const poly = this.lastResult.polygon;
    if (poly && poly.length >= 3) {
      useAnnotations.getState().add({
        tempId: this.generateTempId(),
        classId: cls,
        kind: "polygon",
        geometry: { kind: "polygon", points: poly },
        frameId: this.getFrameId(),
        serverId: null,
        dirty: true,
      });
    } else {
      useAnnotations.getState().add({
        tempId: this.generateTempId(),
        classId: cls,
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
    }
    this.reset();
    return true;
  }
}
