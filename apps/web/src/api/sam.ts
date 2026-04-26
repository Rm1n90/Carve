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
};
