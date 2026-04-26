/**
 * WebGPU + ONNX Runtime Web detection helpers for the in-browser SAM
 * decoder. The actual ONNX model file (`sam2_decoder.onnx`) is provisioned
 * by the operator and served from `/models/sam2_decoder.onnx` (i.e. the
 * web container's `public/models/` directory). When the file is missing or
 * the browser lacks WebGPU, callers should fall back to the server-side
 * `/sam/decode` endpoint.
 */

export const SAM_DECODER_MODEL_URL = "/models/sam2_decoder.onnx";

/**
 * Returns true when the runtime exposes `navigator.gpu`. Stable Chrome
 * supports WebGPU since 113; jsdom (used by tests) does not.
 */
export function isWebGPUAvailable(): boolean {
  return typeof navigator !== "undefined" && "gpu" in navigator;
}

/**
 * HEAD-probe the ONNX model file to confirm it is present in the public
 * folder. Returns false on any network/HTTP failure so the caller can
 * cleanly fall back to the server decoder.
 */
export async function checkDecoderModelAvailable(): Promise<boolean> {
  try {
    const response = await fetch(SAM_DECODER_MODEL_URL, { method: "HEAD" });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Returns true only when both WebGPU and the local model file are present.
 * Combines the two predicates so SamTool has a single yes/no signal.
 */
export async function canDecodeLocally(): Promise<boolean> {
  if (!isWebGPUAvailable()) return false;
  return await checkDecoderModelAvailable();
}
