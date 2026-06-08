// Armin Mehri — mehri.armin@gmail.com
/**
 * Client-side SAM mask decoder — pure logic (no onnxruntime-web import, so it
 * unit-tests without a DOM or WASM). The real ORT session lives in
 * ``decoder.worker.ts``; here we own the numeric contract that must match the
 * Stage-0 golden parity reference
 * (``apps/model/scripts/sam_tracker_parity_check.py``):
 *
 *   - scale image-space points into the encoder's input space (1008 / 1024);
 *   - feed the 3 embeddings + points + (empty) boxes to the decoder;
 *   - threshold each of the 3 candidate masks at logit>0 and nearest-resize
 *     to the original image size;
 *   - SELECTION (the decoder has NO mask_input, so we replicate its tracking
 *     statelessly): first click -> best by iou_scores; refinement clicks ->
 *     the candidate with the highest IoU to the previously-shown mask. This
 *     reproduces the server's mask_input refinement (verified: best-by-score
 *     collapses negatives; track-prev does not).
 *
 * Box prompts diverge from the server box decode -> they stay on the server
 * ``/sam/decode`` fallback and never reach this decoder.
 *
 * See docs/superpowers/specs/2026-06-08-client-side-sam-decode-design.md.
 */

import { encodeRLE } from "../maskio";
import type { CachedEmbeddings } from "./embeddingCache";

export interface EncoderConfig {
  encoderId: string;
  /** Encoder input edge (px): SAM 3 = 1008, SAM 2.1 = 1024. */
  inputSize: number;
  /** Browser decoder served from the web container's public/models/. */
  decoderUrl: string;
  /** ORT input node names for the 3 feature maps. */
  embeddingInputs: readonly string[];
}

const EMBEDDING_INPUTS = [
  "image_embeddings.0",
  "image_embeddings.1",
  "image_embeddings.2",
] as const;

/** Keyed by encoder_id (== SAM_MODEL value). Only the Stage-0 proven bundles. */
export const ENCODER_CONFIGS: Record<string, EncoderConfig> = {
  "sam3.1": {
    encoderId: "sam3.1",
    inputSize: 1008,
    decoderUrl: "/models/sam3.1.decoder.onnx",
    embeddingInputs: EMBEDDING_INPUTS,
  },
  "sam2.1-large": {
    encoderId: "sam2.1-large",
    inputSize: 1024,
    decoderUrl: "/models/sam2.1-large.decoder.onnx",
    embeddingInputs: EMBEDDING_INPUTS,
  },
};

export interface FloatTensor {
  data: Float32Array;
  dims: number[];
}
export interface Int64Tensor {
  data: BigInt64Array;
  dims: number[];
}

export interface PromptFeeds {
  input_points: FloatTensor;
  input_labels: Int64Tensor;
  input_boxes: FloatTensor;
}

/** The full feed dictionary handed to the ORT session. */
export type DecodeFeeds = Record<
  string,
  { data: Float32Array | BigInt64Array; dims: number[] }
>;

export interface DecoderOutputs {
  /** Flattened candidate scores (one per candidate mask). */
  iouScores: Float32Array;
  /** pred_masks logits, dims [B, N, K, H, W]. */
  predMasks: FloatTensor;
}

export type SessionRunner = (feeds: DecodeFeeds) => Promise<DecoderOutputs>;

export interface LocalDecodeRequest {
  embeddings: CachedEmbeddings;
  /** Accumulated click coordinates in original image space. */
  points: [number, number][];
  /** 1 = foreground, 0 = background, one per point. */
  labels: number[];
  /** The previously-shown mask (orig size), or null on the first click. */
  prevMask?: Uint8Array | null;
}

export interface LocalDecodeResult {
  counts: string;
  size: [number, number];
  score: number;
  polygon: [number, number][];
  /** Orig-size binary mask — feed back as ``prevMask`` for the next click. */
  mask: Uint8Array;
}

/**
 * Scale accumulated image-space points into the encoder's input space and
 * pack the ORT prompt tensors. Boxes are always empty here — box prompts use
 * the server fallback.
 */
export function scalePromptToInput(
  points: [number, number][],
  labels: number[],
  inputSize: number,
  origShape: [number, number],
): PromptFeeds {
  const [origH, origW] = origShape;
  const sx = inputSize / origW;
  const sy = inputSize / origH;
  const coords = new Float32Array(points.length * 2);
  for (let i = 0; i < points.length; i += 1) {
    coords[i * 2] = points[i][0] * sx;
    coords[i * 2 + 1] = points[i][1] * sy;
  }
  const lbl = BigInt64Array.from(labels, (v) => BigInt(v));
  return {
    input_points: { data: coords, dims: [1, 1, points.length, 2] },
    input_labels: { data: lbl, dims: [1, 1, labels.length] },
    input_boxes: { data: new Float32Array(0), dims: [1, 0, 4] },
  };
}

/** Intersection-over-union of two equal-length binary masks. */
export function iou(a: Uint8Array, b: Uint8Array): number {
  let inter = 0;
  let union = 0;
  for (let i = 0; i < a.length; i += 1) {
    const av = a[i] ? 1 : 0;
    const bv = b[i] ? 1 : 0;
    if (av | bv) union += 1;
    if (av & bv) inter += 1;
  }
  return union === 0 ? 0 : inter / union;
}

/**
 * Threshold each of the K candidate masks at logit>0 and nearest-resize from
 * the decoder's native HxW to the original image size. ``predMasks.dims`` is
 * ``[B, N, K, H, W]`` (B = N = 1).
 */
export function candidateMasksFromLogits(
  data: Float32Array,
  dims: number[],
  origH: number,
  origW: number,
): Uint8Array[] {
  const w = dims[dims.length - 1];
  const h = dims[dims.length - 2];
  const k = dims[dims.length - 3];
  const stride = h * w;
  const out: Uint8Array[] = [];
  for (let c = 0; c < k; c += 1) {
    const base = c * stride;
    const resized = new Uint8Array(origH * origW);
    for (let oy = 0; oy < origH; oy += 1) {
      const syi = Math.min(h - 1, Math.floor((oy * h) / origH));
      for (let ox = 0; ox < origW; ox += 1) {
        const sxi = Math.min(w - 1, Math.floor((ox * w) / origW));
        resized[oy * origW + ox] = data[base + syi * w + sxi] > 0 ? 1 : 0;
      }
    }
    out.push(resized);
  }
  return out;
}

/**
 * Pick the candidate mask. First click (no previous mask) -> best by
 * iou_scores. Refinement (previous mask exists) -> the candidate most similar
 * to the previous mask (track-prev), which reproduces the server's mask_input
 * refinement that this decoder export lacks.
 */
export function selectCandidate(
  iouScores: Float32Array,
  candidateMasks: Uint8Array[],
  prevMask: Uint8Array | null,
): number {
  let best = 0;
  if (prevMask === null) {
    let bestScore = -Infinity;
    for (let c = 0; c < candidateMasks.length; c += 1) {
      const s = iouScores[c] ?? -Infinity;
      if (s > bestScore) {
        bestScore = s;
        best = c;
      }
    }
    return best;
  }
  let bestIou = -Infinity;
  for (let c = 0; c < candidateMasks.length; c += 1) {
    const v = iou(prevMask, candidateMasks[c]);
    if (v > bestIou) {
      bestIou = v;
      best = c;
    }
  }
  return best;
}

/**
 * Decode one click set locally. The ORT session is injected as ``runner`` so
 * this orchestration is fully unit-testable; the worker supplies the real
 * onnxruntime-web session. Polygon extraction is deferred — the editor commits
 * the returned RLE as a ``mask_rle`` annotation (same kind the brush tool
 * produces), so there is no functionality loss.
 */
export async function decodeWithRunner(
  req: LocalDecodeRequest,
  runner: SessionRunner,
): Promise<LocalDecodeResult> {
  const { embeddings, points, labels, prevMask } = req;
  const [h, w] = embeddings.shape;
  const prompt = scalePromptToInput(points, labels, embeddings.inputSize, embeddings.shape);
  const feeds: DecodeFeeds = { ...prompt };
  for (const [name, tensor] of Object.entries(embeddings.tensors)) {
    feeds[name] = tensor;
  }
  const out = await runner(feeds);
  const masks = candidateMasksFromLogits(out.predMasks.data, out.predMasks.dims, h, w);
  const idx = selectCandidate(out.iouScores, masks, prevMask ?? null);
  const mask = masks[idx] ?? new Uint8Array(h * w);
  return {
    counts: encodeRLE(mask, h, w),
    size: [h, w],
    score: out.iouScores[idx] ?? 0,
    polygon: [],
    mask,
  };
}
