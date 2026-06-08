// Armin Mehri — mehri.armin@gmail.com
import { describe, expect, it } from "vitest";

import {
  ENCODER_CONFIGS,
  candidateMasksFromLogits,
  decodeWithRunner,
  iou,
  scalePromptToInput,
  selectCandidate,
} from "./decoder";
import type { CachedEmbeddings } from "./embeddingCache";

describe("ENCODER_CONFIGS", () => {
  it("maps sam3.1 (1008) and sam2.1-large (1024) to their decoder bundles", () => {
    expect(ENCODER_CONFIGS["sam3.1"].inputSize).toBe(1008);
    expect(ENCODER_CONFIGS["sam3.1"].decoderUrl).toContain("sam3.1");
    expect(ENCODER_CONFIGS["sam2.1-large"].inputSize).toBe(1024);
    expect(ENCODER_CONFIGS["sam2.1-large"].decoderUrl).toContain("sam2.1-large");
  });
});

describe("scalePromptToInput", () => {
  it("scales image-space points into encoder input space (per-axis sx, sy)", () => {
    // orig [h=100, w=200], inputSize 1008 => sx = 1008/200, sy = 1008/100
    const p = scalePromptToInput([[50, 25]], [1], 1008, [100, 200]);
    expect(p.input_points.dims).toEqual([1, 1, 1, 2]);
    expect(p.input_points.data[0]).toBeCloseTo(50 * (1008 / 200), 4); // 252
    expect(p.input_points.data[1]).toBeCloseTo(25 * (1008 / 100), 4); // 252
    expect(p.input_labels.dims).toEqual([1, 1, 1]);
    expect(p.input_labels.data[0]).toBe(1n);
    expect(p.input_boxes.dims).toEqual([1, 0, 4]); // boxes -> server fallback
  });
});

describe("iou", () => {
  it("computes intersection-over-union of two binary masks", () => {
    expect(iou(Uint8Array.from([1, 1, 0, 0]), Uint8Array.from([1, 0, 0, 0]))).toBeCloseTo(
      1 / 2,
      6,
    );
  });
  it("returns 0 for two empty masks", () => {
    expect(iou(new Uint8Array(4), new Uint8Array(4))).toBe(0);
  });
});

describe("candidateMasksFromLogits", () => {
  it("thresholds each candidate at logit>0 and nearest-resizes to original size", () => {
    // dims [1,1,2,2,2]: candidate 0 = top-left only; candidate 1 = all positive
    const data = new Float32Array([1, -1, -1, -1, 1, 1, 1, 1]);
    const masks = candidateMasksFromLogits(data, [1, 1, 2, 2, 2], 4, 4);
    expect(masks).toHaveLength(2);
    expect(masks[0][0]).toBe(1); // (0,0) set
    expect(masks[0][4 * 3 + 3]).toBe(0); // bottom-right clear
    expect(Array.from(masks[1]).every((v) => v === 1)).toBe(true);
  });
});

describe("selectCandidate — Stage-0 track-prev rule", () => {
  const big = Uint8Array.from(Array.from({ length: 16 }, (_, i) => (i < 12 ? 1 : 0)));
  const collapsed = Uint8Array.from(Array.from({ length: 16 }, (_, i) => (i < 1 ? 1 : 0)));

  it("first click (no previous mask) picks the highest iou_score candidate", () => {
    expect(selectCandidate(new Float32Array([0.2, 0.9]), [big, collapsed], null)).toBe(1);
  });

  it("refinement picks the candidate closest to the previous mask, NOT best score", () => {
    // best-by-score would pick `collapsed` (0.9); track-prev must pick `big`.
    expect(selectCandidate(new Float32Array([0.2, 0.9]), [big, collapsed], big)).toBe(0);
  });
});

describe("decodeWithRunner", () => {
  const embeddings: CachedEmbeddings = {
    encoderId: "sam3.1",
    inputSize: 1008,
    norm: { mean: [0.5, 0.5, 0.5], std: [0.5, 0.5, 0.5] },
    shape: [4, 4],
    tensors: {
      "image_embeddings.0": { data: new Float32Array([0]), dims: [1, 1, 1, 1] },
      "image_embeddings.1": { data: new Float32Array([0]), dims: [1, 1, 1, 1] },
      "image_embeddings.2": { data: new Float32Array([0]), dims: [1, 1, 1, 1] },
    },
  };

  it("feeds embeddings + scaled points, selects via track-prev, returns RLE + mask", async () => {
    let seenFeeds: Record<string, { dims: number[] }> | null = null;
    const runner = async (feeds: Record<string, { dims: number[] }>) => {
      seenFeeds = feeds;
      return {
        iouScores: new Float32Array([0.3, 0.95]), // cand1 scores higher
        predMasks: {
          // cand0 = 3 quadrants; cand1 = top-left only (collapsed)
          data: new Float32Array([1, 1, 1, -1, 1, -1, -1, -1]),
          dims: [1, 1, 2, 2, 2],
        },
      };
    };
    const prev = Uint8Array.from(Array.from({ length: 16 }, () => 1)); // resembles cand0

    const res = await decodeWithRunner(
      { embeddings, points: [[1, 1], [2, 2]], labels: [1, 0], prevMask: prev },
      runner,
    );

    // the 3 embeddings + the scaled points reached the session
    expect(seenFeeds!["image_embeddings.0"]).toBeDefined();
    expect(seenFeeds!["image_embeddings.2"]).toBeDefined();
    expect(seenFeeds!.input_points.dims).toEqual([1, 1, 2, 2]);
    // track-prev chose cand0 (score 0.3), NOT the higher-score collapsed cand1
    expect(res.size).toEqual([4, 4]);
    expect(res.score).toBeCloseTo(0.3, 6);
    expect(res.mask).toHaveLength(16);
    expect(res.mask.some((v) => v === 1)).toBe(true);
    // counts is the column-major RLE of the returned mask (server format)
    expect(typeof res.counts).toBe("string");
    expect(res.counts.length).toBeGreaterThan(0);
  });
});
