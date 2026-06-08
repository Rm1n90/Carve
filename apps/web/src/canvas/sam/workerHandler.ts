// Armin Mehri — mehri.armin@gmail.com
/**
 * Message-protocol + worker-side embedding store for the SAM decoder worker.
 * Extracted from ``decoder.worker.ts`` so the protocol/state logic is unit-
 * testable (inject a fake runner + post); the worker file is a thin shell that
 * supplies the real onnxruntime-web session.
 *
 * The worker holds the actual (transferred) embedding tensors so per-click
 * DECODE messages stay tiny — only the click points cross the wire, not the
 * ~10-21 MB feature maps. Two users on different images keep separate cache
 * keys, so a decode never reads another image's embeddings.
 */

import { decodeWithRunner, type LocalDecodeResult, type SessionRunner } from "./decoder";
import type { CachedEmbeddings } from "./embeddingCache";

export type WorkerInbound =
  | { type: "SET_EMBEDDINGS"; cacheKey: string; embeddings: CachedEmbeddings }
  | {
      type: "DECODE";
      id: number;
      cacheKey: string;
      points: [number, number][];
      labels: number[];
      prevMask: Uint8Array | null;
    }
  | { type: "EVICT"; cacheKey: string }
  | { type: "CLEAR" };

export type WorkerOutbound =
  | { type: "DECODE_RESULT"; id: number; ok: true; result: LocalDecodeResult }
  | { type: "DECODE_RESULT"; id: number; ok: false; error: string };

export interface WorkerHandlerDeps {
  /** Resolve (and cache) the ORT runner for a variant. May throw on load failure. */
  getRunner: (encoderId: string) => Promise<SessionRunner>;
  post: (msg: WorkerOutbound, transfer?: Transferable[]) => void;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function createDecoderWorkerHandler(
  deps: WorkerHandlerDeps,
): (msg: WorkerInbound) => Promise<void> {
  const store = new Map<string, CachedEmbeddings>();

  return async function handle(msg: WorkerInbound): Promise<void> {
    switch (msg.type) {
      case "SET_EMBEDDINGS":
        store.set(msg.cacheKey, msg.embeddings);
        return;
      case "EVICT":
        store.delete(msg.cacheKey);
        return;
      case "CLEAR":
        store.clear();
        return;
      case "DECODE": {
        const embeddings = store.get(msg.cacheKey);
        if (!embeddings) {
          deps.post({
            type: "DECODE_RESULT",
            id: msg.id,
            ok: false,
            error: "embeddings_not_cached",
          });
          return;
        }
        try {
          const runner = await deps.getRunner(embeddings.encoderId);
          const result = await decodeWithRunner(
            {
              embeddings,
              points: msg.points,
              labels: msg.labels,
              prevMask: msg.prevMask,
            },
            runner,
          );
          // Transfer the mask buffer back (zero-copy) — the worker no longer
          // needs it after this result is posted.
          deps.post(
            { type: "DECODE_RESULT", id: msg.id, ok: true, result },
            [result.mask.buffer],
          );
        } catch (e) {
          deps.post({
            type: "DECODE_RESULT",
            id: msg.id,
            ok: false,
            error: errorMessage(e),
          });
        }
        return;
      }
    }
  };
}
