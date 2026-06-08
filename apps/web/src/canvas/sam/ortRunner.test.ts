// Armin Mehri — mehri.armin@gmail.com
import { describe, expect, it, vi } from "vitest";

import { createOrtRunner } from "./ortRunner";

class FakeTensor {
  constructor(
    public type: string,
    public data: Float32Array | BigInt64Array,
    public dims: number[],
  ) {}
}

describe("createOrtRunner", () => {
  it("marshals feeds to ORT tensors (int64 labels, float32 rest) and parses outputs", async () => {
    const created: FakeTensor[] = [];
    const Tensor = function (
      this: FakeTensor,
      type: string,
      data: Float32Array | BigInt64Array,
      dims: number[],
    ) {
      const t = new FakeTensor(type, data, dims);
      created.push(t);
      return t;
    } as unknown as new (
      type: string,
      data: Float32Array | BigInt64Array,
      dims: number[],
    ) => unknown;

    const session = {
      run: vi.fn().mockResolvedValue({
        iou_scores: { data: new Float32Array([0.1, 0.9, 0.5]), dims: [1, 1, 3] },
        pred_masks: { data: new Float32Array([1, -1, -1, 1]), dims: [1, 1, 1, 2, 2] },
      }),
    };

    const runner = createOrtRunner(session, Tensor);
    const out = await runner({
      input_points: { data: new Float32Array([1, 2]), dims: [1, 1, 1, 2] },
      input_labels: { data: BigInt64Array.from([1n]), dims: [1, 1, 1] },
      input_boxes: { data: new Float32Array(0), dims: [1, 0, 4] },
      "image_embeddings.0": { data: new Float32Array([0]), dims: [1, 1, 1, 1] },
    });

    // labels marshalled as int64; everything else float32
    const labelTensor = created.find((t) => t.data instanceof BigInt64Array);
    expect(labelTensor?.type).toBe("int64");
    expect(created.filter((t) => t.data instanceof Float32Array).every((t) => t.type === "float32")).toBe(true);
    expect(session.run).toHaveBeenCalledOnce();
    // outputs parsed into the decoder's DecoderOutputs shape (float32 precision)
    expect(out.iouScores).toHaveLength(3);
    expect(out.iouScores[0]).toBeCloseTo(0.1, 6);
    expect(out.iouScores[1]).toBeCloseTo(0.9, 6);
    expect(out.iouScores[2]).toBeCloseTo(0.5, 6);
    expect(out.predMasks.dims).toEqual([1, 1, 1, 2, 2]);
    expect(Array.from(out.predMasks.data)).toEqual([1, -1, -1, 1]);
  });

  it("throws when the decoder output is missing a required tensor", async () => {
    const Tensor = function () {} as unknown as new () => unknown;
    const session = { run: vi.fn().mockResolvedValue({ iou_scores: { data: new Float32Array(), dims: [0] } }) };
    const runner = createOrtRunner(session, Tensor);
    await expect(
      runner({ input_points: { data: new Float32Array(0), dims: [1, 1, 0, 2] } }),
    ).rejects.toThrow(/decoder_missing_outputs/);
  });
});
