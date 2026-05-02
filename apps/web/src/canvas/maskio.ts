// Armin Mehri — mehri.armin@gmail.com
/**
 * Encode a uint8 column-major mask as a comma-separated RLE string of
 * alternating run lengths (zeros first). Decoder is the inverse.
 *
 * NOTE: this is a v1 simplification. Plan 06 will add full COCO
 * LEB128-base64 encoding for cross-format compatibility. Until then,
 * client-side annotations and exports both speak this format.
 */
export function encodeRLE(mask: Uint8Array, h: number, w: number): string {
  if (mask.length !== h * w) {
    throw new Error(`mask length ${mask.length} does not match ${h}x${w}`);
  }
  const runs: number[] = [];
  let prev = 0;
  let run = 0;
  for (let col = 0; col < w; col += 1) {
    for (let row = 0; row < h; row += 1) {
      const v = mask[row * w + col] ? 1 : 0;
      if (v === prev) {
        run += 1;
      } else {
        runs.push(run);
        prev = v;
        run = 1;
      }
    }
  }
  runs.push(run);
  return runs.join(",");
}

export function decodeRLE(counts: string, h: number, w: number): Uint8Array {
  const runs = counts.split(",").map((s) => parseInt(s, 10));
  const mask = new Uint8Array(h * w);
  let i = 0;
  let v = 0;
  for (const run of runs) {
    for (let k = 0; k < run; k += 1) {
      const col = Math.floor(i / h);
      const row = i % h;
      if (col < w) {
        mask[row * w + col] = v;
      }
      i += 1;
    }
    v = v ? 0 : 1;
  }
  return mask;
}
