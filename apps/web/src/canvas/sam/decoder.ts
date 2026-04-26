/**
 * In-browser SAM 2 decoder shell.
 *
 * The real ORT inference here requires the operator to download
 * `sam2_decoder.onnx` to `apps/web/public/models/`. v1 ships only the
 * detection + fallback scaffold; once the model file is present and the
 * input/output tensor names are known for the chosen ONNX export, fill in
 * the input feed and pull `low_res_masks` + `iou_predictions`.
 *
 * Until then, `decodeLocally` throws `local_sam_decoder_not_provisioned`
 * so callers fall back cleanly to the server-side `/sam/decode` endpoint.
 */

import * as ort from "onnxruntime-web";

import { SAM_DECODER_MODEL_URL } from "./onnx";

let _session: ort.InferenceSession | null = null;

/**
 * Lazily create the ONNX Runtime Web session. WebGPU is the preferred
 * execution provider; WASM is the fallback so a stale session can still
 * decode while the GPU adapter warms up. `numThreads = 1` keeps the WASM
 * fallback predictable when the worker pool isn't pre-spawned.
 *
 * Note: this is currently unreachable from `decodeLocally` (which throws
 * `not_provisioned`); it stays here so the v1.1 ORT integration only has
 * to fill in the input feed and parse the output tensors.
 */
async function getSession(): Promise<ort.InferenceSession> {
  if (_session) return _session;
  ort.env.wasm.numThreads = 1;
  _session = await ort.InferenceSession.create(SAM_DECODER_MODEL_URL, {
    executionProviders: ["webgpu", "wasm"],
  });
  return _session;
}

// Export the helper so the v1.1 wiring can reuse it without bumping the
// surface area of this module further. Avoids "unused" lint noise too.
export const _internalGetSession = getSession;

export interface LocalDecodeIn {
  embedding_b64: string;
  shape: [number, number]; // [h, w]
  points: number[][]; // [[x, y], ...]
  labels: number[];
}

export interface LocalDecodeOut {
  counts: string;
  size: [number, number];
  score: number;
}

/**
 * Decode a SAM mask locally via WebGPU. v1 scaffold throws so callers fall
 * back to the server-side `/sam/decode` endpoint without functionality
 * loss. v1.1 will implement the input feed + output decode once the ONNX
 * export's tensor schema is pinned.
 */
export async function decodeLocally(
  _input: LocalDecodeIn,
): Promise<LocalDecodeOut> {
  throw new Error("local_sam_decoder_not_provisioned");
}

export function resetDecoderSession(): void {
  _session = null;
}
