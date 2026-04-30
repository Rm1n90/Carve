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
}

export const samApi = {
  encode: async (assetId: string): Promise<SamEncodeResult> =>
    (await api.post<SamEncodeResult>(`/assets/${assetId}/sam/encode`)).data,
  decode: async (
    assetId: string,
    imageHash: string,
    points: [number, number][],
    labels: number[],
  ): Promise<SamDecodeResult> =>
    (
      await api.post<SamDecodeResult>(`/assets/${assetId}/sam/decode`, {
        image_hash: imageHash,
        points: points.map(([x, y]) => [x, y]),
        labels,
      })
    ).data,
  /**
   * SAM 3 text concept prompt — returns mask candidates for ``text``.
   * Throws an AxiosError with ``response.status === 409`` when the
   * active SAM variant is not SAM 3 (UI should disable the mode).
   */
  textPrompt: async (
    assetId: string,
    text: string,
  ): Promise<SamPromptResult[]> =>
    (
      await api.post<SamPromptResult[]>(
        `/assets/${assetId}/sam/text-prompt`,
        { text },
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
  ): Promise<SamPromptResult[]> => {
    const body: Record<string, unknown> = {
      boxes,
      box_labels: boxLabels,
    };
    if (text !== undefined) body.text = text;
    return (
      await api.post<SamPromptResult[]>(
        `/assets/${assetId}/sam/box-prompt`,
        body,
      )
    ).data;
  },
};
