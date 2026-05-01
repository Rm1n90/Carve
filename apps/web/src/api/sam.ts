import { api } from "./client";

export interface SamEncodeResult {
  image_hash: string;
  shape: [number, number]; // [h, w]
  // Base64 of the float16 image embedding when the model service exposes
  // it. `null` when the predictor lacks `_features` or torch isn't
  // available; callers must fall back to server-side decode in that case.
  embedding_b64: string | null;
}

export interface SamDecodeResult {
  counts: string;
  size: [number, number];
  score: number;
  // v3.8 Phase 1 — Douglas-Peucker simplified outer contour. Empty when
  // the mask has no usable contour. Lets the editor commit as an
  // editable polygon annotation directly.
  polygon: [number, number][];
}

/**
 * Result item from the SAM 3 text/box prompt endpoints. The model
 * service returns a list (one entry per candidate); ``bbox`` is xyxy
 * (image-space pixels) so the canvas can frame the produced mask.
 */
export interface SamPromptResult {
  counts: string;
  size: [number, number];
  score: number;
  bbox: [number, number, number, number];
  // v3.8 Phase 1 — see SamDecodeResult.polygon. SAM 3 factories may emit
  // [] until they're updated; commit logic falls back to the rasterised
  // mask in that case.
  polygon: [number, number][];
}

export const samApi = {
  encode: async (
    assetId: string,
    frameId?: string | null,
  ): Promise<SamEncodeResult> =>
    (
      await api.post<SamEncodeResult>(
        `/assets/${assetId}/sam/encode${frameId ? `?frame_id=${frameId}` : ""}`,
      )
    ).data,
  decode: async (
    assetId: string,
    imageHash: string,
    points: [number, number][],
    labels: number[],
    // v3.8 Phase 1 — optional AbortSignal so the SamTool can cancel a
    // stale decode when a fresh click lands before the previous response
    // arrives. Without this, rapid clicks paint the older mask on top
    // of the newer one (out-of-order render).
    signal?: AbortSignal,
    // v3.8 Phase 2 — optional xyxy box. When provided, /sam/decode runs
    // a box-anchored mask with optional point refinement. Reuses the
    // embedding cache so a box-then-click flow does not re-encode.
    box?: [number, number, number, number] | null,
  ): Promise<SamDecodeResult> => {
    const body: Record<string, unknown> = {
      image_hash: imageHash,
      points: points.map(([x, y]) => [x, y]),
      labels,
    };
    if (box) body.box = box;
    return (
      await api.post<SamDecodeResult>(
        `/assets/${assetId}/sam/decode`,
        body,
        { signal },
      )
    ).data;
  },
  /**
   * SAM 3 text concept prompt — returns mask candidates for ``text``.
   * Throws an AxiosError with ``response.status === 409`` when the
   * active SAM variant is not SAM 3 (UI should disable the mode).
   */
  textPrompt: async (
    assetId: string,
    text: string,
    frameId?: string | null,
  ): Promise<SamPromptResult[]> =>
    (
      await api.post<SamPromptResult[]>(
        `/assets/${assetId}/sam/text-prompt`,
        frameId ? { text, frame_id: frameId } : { text },
      )
    ).data,
  /**
   * v3.8 Phase 3.5 — multi-class SAM 3 text-prompt auto-annotate (sync,
   * single asset). The dialog UI builds the body from a class checklist
   * (only classes whose `text_prompt` is non-empty are eligible). The
   * server saves polygon (preferred) / mask (fallback) annotations
   * above the score threshold.
   */
  autoText: async (
    assetId: string,
    body: {
      class_ids: string[];
      threshold?: number;
      find_all?: boolean;
      overwrite?: boolean;
    },
  ): Promise<{
    annotations_created: number;
    per_class: Record<string, number>;
    ineligible: string[];
  }> =>
    (
      await api.post<{
        annotations_created: number;
        per_class: Record<string, number>;
        ineligible: string[];
      }>(`/assets/${assetId}/sam/auto-text`, body)
    ).data,
  /**
   * v3.8 Phase 3.5 — multi-asset SAM 3 text-prompt batch (RQ-backed).
   * Returns ``{job_id}`` immediately. Poll ``autoTextBatchProgress``
   * until ``status`` is ``completed`` / ``completed_with_errors`` /
   * ``failed``.
   */
  autoTextBatch: async (
    taskId: string,
    body: {
      class_ids: string[];
      threshold?: number;
      find_all?: boolean;
      overwrite?: boolean;
    },
  ): Promise<{ job_id: string }> =>
    (
      await api.post<{ job_id: string }>(
        `/tasks/${taskId}/sam/auto-text-batch`,
        body,
      )
    ).data,
  autoTextBatchProgress: async (
    taskId: string,
    jobId: string,
  ): Promise<{
    status: string;
    done: number;
    total: number;
    failed: number;
    errors: string[];
    total_annotations_created: number;
  }> =>
    (
      await api.get<{
        status: string;
        done: number;
        total: number;
        failed: number;
        errors: string[];
        total_annotations_created: number;
      }>(`/tasks/${taskId}/sam/auto-text-batch/${jobId}`)
    ).data,
  autoTextBatchCancel: async (
    taskId: string,
    jobId: string,
  ): Promise<{ job_id: string; status: string }> =>
    (
      await api.post<{ job_id: string; status: string }>(
        `/tasks/${taskId}/sam/auto-text-batch/${jobId}/cancel`,
      )
    ).data,
  /**
   * SAM 3 box prompt — boxes are xyxy floats; ``boxLabels`` are 1
   * (positive include) or 0 (negative exclude). The optional ``text``
   * combines a concept with the boxes for refinement.
   */
  boxPrompt: async (
    assetId: string,
    boxes: [number, number, number, number][],
    boxLabels: number[],
    text?: string,
    frameId?: string | null,
  ): Promise<SamPromptResult[]> => {
    const body: Record<string, unknown> = {
      boxes,
      box_labels: boxLabels,
    };
    if (text !== undefined) body.text = text;
    if (frameId) body.frame_id = frameId;
    return (
      await api.post<SamPromptResult[]>(
        `/assets/${assetId}/sam/box-prompt`,
        body,
      )
    ).data;
  },
};
