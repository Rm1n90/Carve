// Armin Mehri — mehri.armin@gmail.com
import { describe, expect, it } from "vitest";

import { SamDecoderClient, type WorkerLike } from "./decoderClient";
import { createDecoderWorkerHandler } from "./workerHandler";
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

/** A WorkerLike backed by the real worker handler, running in-process. */
function inProcessWorker(runner: SessionRunner = fakeRunner): WorkerLike {
  let onmessage: ((e: { data: never }) => void) | null = null;
  const handle = createDecoderWorkerHandler({
    getRunner: async () => runner,
    post: (m) => onmessage?.({ data: m as never }),
  });
  return {
    postMessage: (m: unknown) => {
      void handle(m as never);
    },
    get onmessage() {
      return onmessage as never;
    },
    set onmessage(h: never) {
      onmessage = h;
    },
  };
}

describe("SamDecoderClient", () => {
  it("resolves a decode once embeddings are cached in the worker", async () => {
    const client = new SamDecoderClient(() => inProcessWorker());
    client.setEmbeddings("k", embeddings);
    const result = await client.decode("k", [[1, 1]], [1], null);
    expect(result.size).toEqual([2, 2]);
    expect(result.mask).toHaveLength(4);
  });

  it("rejects when the worker reports an uncached image", async () => {
    const client = new SamDecoderClient(() => inProcessWorker());
    await expect(client.decode("missing", [[1, 1]], [1], null)).rejects.toThrow(
      /embeddings_not_cached/,
    );
  });

  it("rejects immediately when the signal is already aborted", async () => {
    const client = new SamDecoderClient(() => inProcessWorker());
    const ac = new AbortController();
    ac.abort();
    await expect(
      client.decode("k", [[1, 1]], [1], null, ac.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("correlates concurrent decodes to their own promises", async () => {
    const client = new SamDecoderClient(() => inProcessWorker());
    client.setEmbeddings("k", embeddings);
    const [a, b] = await Promise.all([
      client.decode("k", [[1, 1]], [1], null),
      client.decode("k", [[0, 0]], [1], null),
    ]);
    expect(a.size).toEqual([2, 2]);
    expect(b.size).toEqual([2, 2]);
  });
});
