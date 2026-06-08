// Armin Mehri — mehri.armin@gmail.com
import { describe, expect, it } from "vitest";

import {
  EmbeddingCache,
  cachedEmbeddingsFromEncode,
} from "./embeddingCache";

function fakeEmbeddings(id: string) {
  return {
    encoderId: id,
    inputSize: 1008,
    norm: { mean: [0.5, 0.5, 0.5], std: [0.5, 0.5, 0.5] },
    shape: [100, 200] as [number, number],
    tensors: {
      "image_embeddings.0": { data: new Float32Array([1, 2]), dims: [1, 2] },
    },
  };
}

describe("EmbeddingCache.key", () => {
  it("composes a stable (asset, frame, encoder) key; null frame collapses to ''", () => {
    expect(EmbeddingCache.key("a", "f1", "sam3.1")).toBe("a|f1|sam3.1");
    expect(EmbeddingCache.key("a", null, "sam3.1")).toBe("a||sam3.1");
  });

  it("keys different frames / encoders separately (no cross-user collision)", () => {
    expect(EmbeddingCache.key("a", "f1", "sam3.1")).not.toBe(
      EmbeddingCache.key("a", "f2", "sam3.1"),
    );
    expect(EmbeddingCache.key("a", "f1", "sam3.1")).not.toBe(
      EmbeddingCache.key("a", "f1", "sam2.1-large"),
    );
  });
});

describe("EmbeddingCache LRU", () => {
  it("evicts the least-recently-used entry past capacity", () => {
    const c = new EmbeddingCache(2);
    c.set("a", null, "sam3.1", fakeEmbeddings("A"));
    c.set("b", null, "sam3.1", fakeEmbeddings("B"));
    c.set("d", null, "sam3.1", fakeEmbeddings("D")); // evicts A (oldest)
    expect(c.get("a", null, "sam3.1")).toBeUndefined();
    expect(c.get("b", null, "sam3.1")?.encoderId).toBe("B");
    expect(c.get("d", null, "sam3.1")?.encoderId).toBe("D");
    expect(c.size).toBe(2);
  });

  it("get() refreshes recency so the touched entry survives eviction", () => {
    const c = new EmbeddingCache(2);
    c.set("a", null, "sam3.1", fakeEmbeddings("A"));
    c.set("b", null, "sam3.1", fakeEmbeddings("B"));
    c.get("a", null, "sam3.1"); // A is now most-recent
    c.set("d", null, "sam3.1", fakeEmbeddings("D")); // evicts B, not A
    expect(c.get("a", null, "sam3.1")?.encoderId).toBe("A");
    expect(c.get("b", null, "sam3.1")).toBeUndefined();
  });

  it("invalidateEncoder drops every entry for a variant (cache reset on switch)", () => {
    const c = new EmbeddingCache(8);
    c.set("a", null, "sam3.1", fakeEmbeddings("A"));
    c.set("a", null, "sam2.1-large", fakeEmbeddings("A2"));
    c.set("b", "f1", "sam3.1", fakeEmbeddings("B"));
    c.invalidateEncoder("sam3.1");
    expect(c.get("a", null, "sam3.1")).toBeUndefined();
    expect(c.get("b", "f1", "sam3.1")).toBeUndefined();
    expect(c.get("a", null, "sam2.1-large")?.encoderId).toBe("A2"); // other variant kept
  });
});

describe("cachedEmbeddingsFromEncode", () => {
  const tensorBytes = (() => {
    // float16 [1.0, 0.5] little-endian => 0x3c00, 0x3800
    const bytes = new Uint8Array([0x00, 0x3c, 0x00, 0x38]);
    return btoa(String.fromCharCode(...bytes));
  })();

  it("returns null when client-decode tensors are absent (server fallback)", () => {
    expect(
      cachedEmbeddingsFromEncode({
        shape: [10, 20],
        encoder_id: null,
        input_size: null,
        norm: null,
        tensors: null,
      }),
    ).toBeNull();
  });

  it("decodes the float16 tensors to Float32 with dims + metadata", () => {
    const out = cachedEmbeddingsFromEncode({
      shape: [10, 20],
      encoder_id: "sam3.1",
      input_size: 1008,
      norm: { mean: [0.5, 0.5, 0.5], std: [0.5, 0.5, 0.5] },
      tensors: {
        "image_embeddings.0": { b64: tensorBytes, dtype: "float16", shape: [1, 2] },
      },
    });
    expect(out).not.toBeNull();
    expect(out!.encoderId).toBe("sam3.1");
    expect(out!.inputSize).toBe(1008);
    expect(out!.shape).toEqual([10, 20]);
    const t = out!.tensors["image_embeddings.0"];
    expect(t.dims).toEqual([1, 2]);
    expect(Array.from(t.data)).toEqual([1, 0.5]);
  });
});
