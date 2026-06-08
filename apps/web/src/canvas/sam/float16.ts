// Armin Mehri — mehri.armin@gmail.com
/**
 * IEEE-754 half-precision (float16) decoding for the client-side SAM
 * decoder. The model service ships the 3 encoder feature maps as base64
 * float16 to halve the payload (~10.6 MB vs ~21.2 MB per image); the
 * browser decoder needs them as float32 to feed onnxruntime-web.
 *
 * Pure + dependency-free so it unit-tests without a DOM or ORT.
 */

/** Convert one IEEE-754 half (16-bit) bit pattern to a JS number. */
function halfBitsToFloat(h: number): number {
  const sign = (h & 0x8000) >> 15;
  const exponent = (h & 0x7c00) >> 10;
  const fraction = h & 0x03ff;

  let value: number;
  if (exponent === 0) {
    // Subnormal (or zero): no implicit leading 1.
    value = fraction * Math.pow(2, -24);
  } else if (exponent === 0x1f) {
    value = fraction === 0 ? Infinity : NaN;
  } else {
    value = (1 + fraction / 1024) * Math.pow(2, exponent - 15);
  }
  return sign === 1 ? -value : value;
}

/** Decode a Uint16Array of float16 bit patterns into a Float32Array. */
export function float16ToFloat32(halves: Uint16Array): Float32Array {
  const out = new Float32Array(halves.length);
  for (let i = 0; i < halves.length; i += 1) {
    out[i] = halfBitsToFloat(halves[i]);
  }
  return out;
}

/**
 * Decode a base64 string of little-endian float16 bytes into a
 * Float32Array. Trailing odd byte (if any) is ignored — encoder feature
 * maps are always an even number of bytes.
 */
export function decodeFloat16Base64(b64: string): Float32Array {
  const binary = atob(b64);
  const byteLen = binary.length;
  const bytes = new Uint8Array(byteLen);
  for (let i = 0; i < byteLen; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  // Interpret the freshly-allocated (offset 0, 2-byte-aligned) buffer as
  // little-endian uint16; every supported browser is little-endian.
  const halves = new Uint16Array(bytes.buffer, 0, byteLen >> 1);
  return float16ToFloat32(halves);
}
