import { describe, expect, it } from "vitest";
import { decodeRLE, encodeRLE } from "@/canvas/maskio";

describe("RLE encode/decode", () => {
  it("round-trips a known 4×4 mask", () => {
    // 4×4 mask: a 2×2 block of ones in the top-left
    const m = new Uint8Array([
      1, 1, 0, 0,
      1, 1, 0, 0,
      0, 0, 0, 0,
      0, 0, 0, 0,
    ]);
    const counts = encodeRLE(m, 4, 4);
    const back = decodeRLE(counts, 4, 4);
    expect(Array.from(back)).toEqual(Array.from(m));
  });

  it("round-trips an all-zero mask", () => {
    const m = new Uint8Array(16);
    const counts = encodeRLE(m, 4, 4);
    const back = decodeRLE(counts, 4, 4);
    expect(Array.from(back)).toEqual(Array.from(m));
  });

  it("round-trips an all-one mask", () => {
    const m = new Uint8Array(16).fill(1);
    const counts = encodeRLE(m, 4, 4);
    const back = decodeRLE(counts, 4, 4);
    expect(Array.from(back)).toEqual(Array.from(m));
  });

  it("encode rejects mismatched length", () => {
    expect(() => encodeRLE(new Uint8Array(10), 4, 4)).toThrow();
  });
});
