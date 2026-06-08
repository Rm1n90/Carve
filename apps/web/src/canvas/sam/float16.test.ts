// Armin Mehri — mehri.armin@gmail.com
import { describe, expect, it } from "vitest";

import { decodeFloat16Base64, float16ToFloat32 } from "./float16";

describe("float16ToFloat32", () => {
  it("decodes representative IEEE-754 half values exactly", () => {
    // bit patterns: 0.0, 1.0, -2.0, 0.5
    const halves = new Uint16Array([0x0000, 0x3c00, 0xc000, 0x3800]);
    const out = float16ToFloat32(halves);
    expect(Array.from(out)).toEqual([0, 1, -2, 0.5]);
  });

  it("decodes subnormals and the largest normal half value", () => {
    // 0x0001 = smallest positive subnormal = 2**-24; 0x7bff = 65504 (max half)
    const out = float16ToFloat32(new Uint16Array([0x0001, 0x7bff]));
    expect(out[0]).toBeCloseTo(Math.pow(2, -24), 30);
    expect(out[1]).toBe(65504);
  });

  it("preserves negative zero sign", () => {
    const out = float16ToFloat32(new Uint16Array([0x8000]));
    expect(Object.is(out[0], -0)).toBe(true);
  });
});

describe("decodeFloat16Base64", () => {
  it("round-trips a little-endian float16 byte buffer", () => {
    // 1.0 (0x3c00) then 0.5 (0x3800), little-endian bytes.
    const bytes = new Uint8Array([0x00, 0x3c, 0x00, 0x38]);
    const b64 = btoa(String.fromCharCode(...bytes));
    const out = decodeFloat16Base64(b64);
    expect(Array.from(out)).toEqual([1, 0.5]);
  });
});
