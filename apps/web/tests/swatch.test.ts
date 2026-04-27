import { describe, expect, it } from "vitest";
import { nextHexForIdx, PALETTE_HEX, swatchForIdx, SWATCH_VARS } from "@/lib/swatch";

describe("nextHexForIdx", () => {
  it("returns a #RRGGBB string for idx 0, 1, and 11", () => {
    const a = nextHexForIdx(0);
    const b = nextHexForIdx(1);
    const c = nextHexForIdx(11);
    for (const v of [a, b, c]) {
      expect(v).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
  });

  it("returns deterministic distinct values for sequential indices", () => {
    const a = nextHexForIdx(0);
    const b = nextHexForIdx(1);
    const c = nextHexForIdx(11);
    expect(a).not.toEqual(b);
    expect(b).not.toEqual(c);
    expect(a).not.toEqual(c);
    // Stability — calling with the same idx returns the same hex.
    expect(nextHexForIdx(0)).toEqual(a);
    expect(nextHexForIdx(11)).toEqual(c);
  });

  it("wraps on indices >= palette length", () => {
    expect(nextHexForIdx(PALETTE_HEX.length)).toEqual(PALETTE_HEX[0]);
    expect(nextHexForIdx(PALETTE_HEX.length + 1)).toEqual(PALETTE_HEX[1]);
  });

  it("wraps negative indices into the palette range", () => {
    expect(nextHexForIdx(-1)).toEqual(PALETTE_HEX[PALETTE_HEX.length - 1]);
  });
});

describe("swatchForIdx (regression)", () => {
  it("returns a CSS variable for any non-negative index", () => {
    expect(swatchForIdx(0)).toEqual(SWATCH_VARS[0]);
    expect(swatchForIdx(SWATCH_VARS.length)).toEqual(SWATCH_VARS[0]);
  });
});
