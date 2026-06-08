// Armin Mehri — mehri.armin@gmail.com
/**
 * Adapter from the decoder's plain feed/output shapes to an onnxruntime-web
 * ``InferenceSession``. The session and the ``Tensor`` constructor are
 * injected so the marshalling is unit-testable without loading ORT (the real
 * binding is supplied by ``decoder.worker.ts``).
 */

import type { DecodeFeeds, DecoderOutputs, SessionRunner } from "./decoder";

export interface OrtTensorCtor {
  new (
    type: string,
    data: Float32Array | BigInt64Array,
    dims: number[],
  ): unknown;
}

export interface OrtValue {
  data: ArrayLike<number>;
  dims: readonly number[];
}

export interface OrtSessionLike {
  run(feeds: Record<string, unknown>): Promise<Record<string, OrtValue>>;
}

export function createOrtRunner(
  session: OrtSessionLike,
  Tensor: OrtTensorCtor,
): SessionRunner {
  return async (feeds: DecodeFeeds): Promise<DecoderOutputs> => {
    const ortFeeds: Record<string, unknown> = {};
    for (const [name, tensor] of Object.entries(feeds)) {
      const type = tensor.data instanceof BigInt64Array ? "int64" : "float32";
      ortFeeds[name] = new Tensor(type, tensor.data, [...tensor.dims]);
    }
    const out = await session.run(ortFeeds);
    const iou = out["iou_scores"];
    const pred = out["pred_masks"];
    if (!iou || !pred) {
      throw new Error("decoder_missing_outputs");
    }
    return {
      iouScores: Float32Array.from(iou.data),
      predMasks: { data: Float32Array.from(pred.data), dims: [...pred.dims] },
    };
  };
}
