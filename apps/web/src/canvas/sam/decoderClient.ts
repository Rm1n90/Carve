// Armin Mehri — mehri.armin@gmail.com
/**
 * Main-thread bridge to the SAM decoder Web Worker. Owns the worker lifecycle,
 * correlates DECODE responses by id, and exposes a Promise-based ``decode``
 * with AbortSignal support. The worker is spawned lazily (so onnxruntime-web
 * only loads when local decode is actually used) and injectable so the
 * correlation logic unit-tests against an in-process fake worker.
 */

import type { LocalDecodeResult } from "./decoder";
import type { CachedEmbeddings } from "./embeddingCache";
import type { WorkerInbound, WorkerOutbound } from "./workerHandler";

export interface WorkerLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((e: { data: WorkerOutbound }) => void) | null;
  terminate?(): void;
}

interface Pending {
  resolve: (r: LocalDecodeResult) => void;
  reject: (e: Error) => void;
}

function abortError(): Error {
  // DOMException isn't always constructable in every test env; a plain Error
  // tagged with the AbortError name behaves the same for our callers.
  const e = new Error("aborted");
  e.name = "AbortError";
  return e;
}

export class SamDecoderClient {
  private worker: WorkerLike | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();

  constructor(private readonly spawn: () => WorkerLike = defaultSpawn) {}

  private ensure(): WorkerLike {
    if (this.worker) return this.worker;
    const w = this.spawn();
    w.onmessage = (e) => this.onMessage(e.data);
    this.worker = w;
    return w;
  }

  private onMessage(msg: WorkerOutbound): void {
    if (msg.type !== "DECODE_RESULT") return;
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(new Error(msg.error));
  }

  /** Cache an image's embeddings in the worker (sent once per image). */
  setEmbeddings(cacheKey: string, embeddings: CachedEmbeddings): void {
    const msg: WorkerInbound = { type: "SET_EMBEDDINGS", cacheKey, embeddings };
    this.ensure().postMessage(msg);
  }

  /** Drop one image's embeddings (variant switch / frame change). */
  evict(cacheKey: string): void {
    if (!this.worker) return;
    const msg: WorkerInbound = { type: "EVICT", cacheKey };
    this.worker.postMessage(msg);
  }

  /** Decode a click set locally. Rejects on worker error or abort. */
  decode(
    cacheKey: string,
    points: [number, number][],
    labels: number[],
    prevMask: Uint8Array | null,
    signal?: AbortSignal,
  ): Promise<LocalDecodeResult> {
    const worker = this.ensure();
    const id = this.nextId;
    this.nextId += 1;
    return new Promise<LocalDecodeResult>((resolve, reject) => {
      if (signal?.aborted) {
        reject(abortError());
        return;
      }
      this.pending.set(id, { resolve, reject });
      if (signal) {
        signal.addEventListener(
          "abort",
          () => {
            if (this.pending.delete(id)) reject(abortError());
          },
          { once: true },
        );
      }
      const msg: WorkerInbound = { type: "DECODE", id, cacheKey, points, labels, prevMask };
      worker.postMessage(msg);
    });
  }

  dispose(): void {
    this.worker?.terminate?.();
    this.worker = null;
    this.pending.clear();
  }
}

function defaultSpawn(): WorkerLike {
  return new Worker(new URL("./decoder.worker.ts", import.meta.url), {
    type: "module",
  }) as unknown as WorkerLike;
}
