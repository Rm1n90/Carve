// Armin Mehri — mehri.armin@gmail.com
/**
 * Capability detection for the in-browser SAM decoder. Each interactive
 * variant ships its own decoder bundle (``/models/<encoder_id>.decoder.onnx``,
 * provisioned by the operator in Stage 4). ``canDecodeLocally`` is the single
 * yes/no gate SamTool consults before decoding a click locally; when it is
 * false (unknown variant, decoder file missing, offline) the caller falls back
 * to the server ``/sam/decode`` endpoint with no functionality loss.
 *
 * WebGPU is NOT required: onnxruntime-web runs the decoder on its WASM
 * execution provider when WebGPU is absent. ``isWebGPUAvailable`` only lets the
 * worker prefer the faster WebGPU EP when it exists.
 */

import { ENCODER_CONFIGS } from "./decoder";

/** Decoder bundle URL for a variant, or null when it has no client decoder. */
export function decoderUrlFor(encoderId: string): string | null {
  return ENCODER_CONFIGS[encoderId]?.decoderUrl ?? null;
}

/** True when the runtime exposes ``navigator.gpu`` (Chrome 113+; not jsdom). */
export function isWebGPUAvailable(): boolean {
  return typeof navigator !== "undefined" && "gpu" in navigator;
}

/**
 * HEAD-probe the variant's decoder file. Returns false on any network/HTTP
 * failure so the caller cleanly falls back to the server decoder.
 */
export async function checkDecoderModelAvailable(
  encoderId: string,
): Promise<boolean> {
  const url = decoderUrlFor(encoderId);
  if (!url) return false;
  try {
    const response = await fetch(url, { method: "HEAD" });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Whether a click for ``encoderId`` can be decoded in the browser. Requires a
 * known variant and its decoder file to be present. ``undefined`` /
 * ``null`` encoder id (e.g. an older server that didn't return one) -> false.
 */
export async function canDecodeLocally(
  encoderId?: string | null,
): Promise<boolean> {
  if (!encoderId) return false;
  return checkDecoderModelAvailable(encoderId);
}
