// Armin Mehri — mehri.armin@gmail.com
/// <reference lib="webworker" />
/**
 * SAM decoder Web Worker shell. Decode runs off the main thread so per-click
 * onnxruntime-web inference never janks the canvas. All logic lives in tested
 * modules — ``decoder.ts`` (numeric contract + track-prev selection),
 * ``ortRunner.ts`` (tensor marshalling), ``workerHandler.ts`` (protocol +
 * embedding store). This file only loads the real ORT session and wires
 * ``onmessage``; onnxruntime-web is dynamically imported so it lands in its own
 * chunk off the initial bundle.
 *
 * Spawn (Stage 3): ``new Worker(new URL("./decoder.worker.ts", import.meta.url),
 * { type: "module" })``.
 */

import { ENCODER_CONFIGS, type SessionRunner } from "./decoder";
import { isWebGPUAvailable } from "./onnx";
import {
  createOrtRunner,
  type OrtSessionLike,
  type OrtTensorCtor,
} from "./ortRunner";
import { createDecoderWorkerHandler, type WorkerInbound } from "./workerHandler";

const ctx = self as unknown as DedicatedWorkerGlobalScope;

// One resident ORT runner per variant. WebGPU is preferred; WASM is the
// universal fallback so decode still works without a GPU adapter.
const runners = new Map<string, SessionRunner>();

async function getRunner(encoderId: string): Promise<SessionRunner> {
  const cached = runners.get(encoderId);
  if (cached) return cached;
  const cfg = ENCODER_CONFIGS[encoderId];
  if (!cfg) throw new Error(`unknown_encoder:${encoderId}`);
  const ort = await import("onnxruntime-web");
  // Self-host the WASM runtime from public/models/ort/ (provisioned by
  // apps/model/scripts/provision_sam_decoders.py) — no third-party CDN.
  ort.env.wasm.wasmPaths = "/models/ort/";
  // Single-threaded keeps the WASM EP working without cross-origin isolation
  // (COOP/COEP) headers; WebGPU handles the fast path when available.
  ort.env.wasm.numThreads = 1;
  const session = await ort.InferenceSession.create(cfg.decoderUrl, {
    executionProviders: isWebGPUAvailable() ? ["webgpu", "wasm"] : ["wasm"],
  });
  const runner = createOrtRunner(
    session as unknown as OrtSessionLike,
    ort.Tensor as unknown as OrtTensorCtor,
  );
  runners.set(encoderId, runner);
  return runner;
}

const handle = createDecoderWorkerHandler({
  getRunner,
  post: (msg, transfer) => ctx.postMessage(msg, transfer ?? []),
});

ctx.onmessage = (e: MessageEvent<WorkerInbound>): void => {
  void handle(e.data);
};
