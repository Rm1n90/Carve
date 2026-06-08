// Armin Mehri — mehri.armin@gmail.com
/**
 * Per-(asset, frame, encoder) LRU cache of decoded SAM encoder embeddings.
 *
 * CVAT-style split: the server encodes an image ONCE and ships the 3 feature
 * maps; the browser keeps them here so every subsequent click decodes locally
 * with no server round-trip. Keying by encoder_id (the active variant) means
 * a sam2 <-> sam3.1 switch can't reuse stale embeddings, and keying by
 * (asset, frame) means two users on different images never collide — each
 * browser holds only its own embeddings.
 *
 * Each entry is ~10-21 MB (float32), so the cache is capped and evicts the
 * least-recently-used image; a cache miss silently re-encodes (no user
 * error). See docs/superpowers/specs/2026-06-08-client-side-sam-decode-design.md.
 */

import { decodeFloat16Base64 } from "./float16";

export interface SamTensor {
  data: Float32Array;
  dims: number[];
}

export interface CachedEmbeddings {
  encoderId: string;
  inputSize: number;
  norm: { mean: number[]; std: number[] };
  /** Original image dimensions [h, w] — used to scale points + the output mask. */
  shape: [number, number];
  /** image_embeddings.0 / .1 / .2 as float32 tensors with their dims. */
  tensors: Record<string, SamTensor>;
}

/** The subset of the /sam/encode response this module consumes. */
export interface EncodeTensorsInput {
  shape: [number, number];
  encoder_id?: string | null;
  input_size?: number | null;
  norm?: { mean: number[]; std: number[] } | null;
  tensors?: Record<string, { b64: string; dtype: string; shape: number[] }> | null;
}

/** Default capacity (~16 images * ~10-21 MB). */
const DEFAULT_CAPACITY = 16;

export class EmbeddingCache {
  // Map preserves insertion order: the first key is the least-recently-used.
  private readonly entries = new Map<string, CachedEmbeddings>();

  constructor(private readonly capacity: number = DEFAULT_CAPACITY) {}

  static key(assetId: string, frameId: string | null, encoderId: string): string {
    return `${assetId}|${frameId ?? ""}|${encoderId}`;
  }

  get(
    assetId: string,
    frameId: string | null,
    encoderId: string,
  ): CachedEmbeddings | undefined {
    const k = EmbeddingCache.key(assetId, frameId, encoderId);
    const value = this.entries.get(k);
    if (value === undefined) return undefined;
    // Refresh recency: re-insert moves the key to the most-recent position.
    this.entries.delete(k);
    this.entries.set(k, value);
    return value;
  }

  has(assetId: string, frameId: string | null, encoderId: string): boolean {
    return this.entries.has(EmbeddingCache.key(assetId, frameId, encoderId));
  }

  set(
    assetId: string,
    frameId: string | null,
    encoderId: string,
    value: CachedEmbeddings,
  ): void {
    const k = EmbeddingCache.key(assetId, frameId, encoderId);
    if (this.entries.has(k)) this.entries.delete(k);
    this.entries.set(k, value);
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  /** Drop every entry for a variant — call on a sam2 <-> sam3.1 switch. */
  invalidateEncoder(encoderId: string): void {
    const suffix = `|${encoderId}`;
    for (const k of [...this.entries.keys()]) {
      if (k.endsWith(suffix)) this.entries.delete(k);
    }
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}

/**
 * Build cached embeddings from a /sam/encode response. Returns ``null`` when
 * the response carries no client-decode tensors (the variant has no proven
 * ONNX bundle, or the server gate is off) — the caller then falls back to the
 * server /sam/decode path.
 */
export function cachedEmbeddingsFromEncode(
  result: EncodeTensorsInput,
): CachedEmbeddings | null {
  if (
    !result.tensors ||
    !result.encoder_id ||
    !result.input_size ||
    !result.norm
  ) {
    return null;
  }
  const tensors: Record<string, SamTensor> = {};
  for (const [name, payload] of Object.entries(result.tensors)) {
    tensors[name] = {
      data: decodeFloat16Base64(payload.b64),
      dims: payload.shape,
    };
  }
  return {
    encoderId: result.encoder_id,
    inputSize: result.input_size,
    norm: result.norm,
    shape: result.shape,
    tensors,
  };
}

/** Process-wide cache shared by the SAM tool + decoder worker host. */
export const embeddingCache = new EmbeddingCache();
