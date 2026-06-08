// Armin Mehri — mehri.armin@gmail.com
import { describe, expect, it, vi } from "vitest";

import { createDecoderWorkerHandler, type WorkerOutbound } from "./workerHandler";
import type { CachedEmbeddings } from "./embeddingCache";
import type { SessionRunner } from "./decoder";

const embeddings: CachedEmbeddings = {
  encoderId: "sam3.1",
  inputSize: 1008,
  norm: { mean: [0.5, 0.5, 0.5], std: [0.5, 0.5, 0.5] },
  shape: [2, 2],
  tensors: {
    "image_embeddings.0": { data: new Float32Array([0]), dims: [1, 1, 1, 1] },
    "image_embeddings.1": { data: new Float32Array([0]), dims: [1, 1, 1, 1] },
    "image_embeddings.2": { data: new Float32Array([0]), dims: [1, 1, 1, 1] },
  },
};

const fakeRunner: SessionRunner = async () => ({
  iouScores: new Float32Array([0.9]),
  predMasks: { data: new Float32Array([1, 1, 1, 1]), dims: [1, 1, 1, 2, 2] },
});

describe("decoder worker handler", () => {
  it("decodes after embeddings are cached and posts an ok result", async () => {
    const posts: WorkerOutbound[] = [];
    const getRunner = vi.fn(async () => fakeRunner);
    const handle = createDecoderWorkerHandler({ getRunner, post: (m) => posts.push(m) });

    await handle({ type: "SET_EMBEDDINGS", cacheKey: "k", embeddings });
    await handle({ type: "DECODE", id: 7, cacheKey: "k", points: [[1, 1]], labels: [1], prevMask: null });

    expect(getRunner).toHaveBeenCalledWith("sam3.1");
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ type: "DECODE_RESULT", id: 7, ok: true });
    expect(posts[0].ok === true && posts[0].result.size).toEqual([2, 2]);
  });

  it("posts an error when decoding an image whose embeddings aren't cached", async () => {
    const posts: WorkerOutbound[] = [];
    const handle = createDecoderWorkerHandler({
      getRunner: async () => fakeRunner,
      post: (m) => posts.push(m),
    });
    await handle({ type: "DECODE", id: 3, cacheKey: "missing", points: [[1, 1]], labels: [1], prevMask: null });
    expect(posts[0]).toMatchObject({ id: 3, ok: false });
    expect(posts[0].ok === false && posts[0].error).toContain("embeddings_not_cached");
  });

  it("surfaces a session/runner failure as an error result (caller falls back to server)", async () => {
    const posts: WorkerOutbound[] = [];
    const handle = createDecoderWorkerHandler({
      getRunner: async () => {
        throw new Error("session_create_failed");
      },
      post: (m) => posts.push(m),
    });
    await handle({ type: "SET_EMBEDDINGS", cacheKey: "k", embeddings });
    await handle({ type: "DECODE", id: 1, cacheKey: "k", points: [[1, 1]], labels: [1], prevMask: null });
    expect(posts[0]).toMatchObject({ ok: false });
    expect(posts[0].ok === false && posts[0].error).toContain("session_create_failed");
  });

  it("EVICT drops a cached image so a later decode errors (cache miss -> re-encode)", async () => {
    const posts: WorkerOutbound[] = [];
    const handle = createDecoderWorkerHandler({
      getRunner: async () => fakeRunner,
      post: (m) => posts.push(m),
    });
    await handle({ type: "SET_EMBEDDINGS", cacheKey: "k", embeddings });
    await handle({ type: "EVICT", cacheKey: "k" });
    await handle({ type: "DECODE", id: 2, cacheKey: "k", points: [[1, 1]], labels: [1], prevMask: null });
    expect(posts[0]).toMatchObject({ ok: false });
    expect(posts[0].ok === false && posts[0].error).toContain("embeddings_not_cached");
  });
});
