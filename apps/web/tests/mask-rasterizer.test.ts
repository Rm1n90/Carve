import { describe, expect, it } from "vitest";

import { MaskRasterizer } from "@/canvas/MaskRasterizer";

describe("MaskRasterizer", () => {
  it("starts empty (no pixels painted)", () => {
    const r = new MaskRasterizer(16, 16);
    expect(r.hasAnyPixel()).toBe(false);
    const enc = r.encodeRLE();
    // All zero → single run of length 16*16 = 256.
    expect(enc.size).toEqual([16, 16]);
    expect(enc.counts).toBe("256");
  });

  it("paintBrush at (50, 50) radius 10 produces non-zero coverage", () => {
    const r = new MaskRasterizer(128, 128);
    r.paintBrush(50, 50, 10, "draw");
    expect(r.hasAnyPixel()).toBe(true);
    const mask = r.binaryMask();
    let total = 0;
    for (let i = 0; i < mask.length; i += 1) total += mask[i];
    // A radius-10 disc covers ~π*100 ≈ 314 pixels. Allow some slack for
    // pixel-rounding (rasterization fills at least pi*r*r, with some
    // border error). Be generous on bounds.
    expect(total).toBeGreaterThan(150);
    expect(total).toBeLessThan(450);
  });

  it("decodeRLE then encodeRLE round-trips deterministically", () => {
    // Encode a known shape: a 2x2 block at top-left of a 4x4 mask.
    // Column-major counts (zeros first): for the block at (row 0..1, col 0..1)
    // — column 0 reads rows 0,1 (=1,1), rows 2,3 (=0,0). Column 1: same.
    // Columns 2,3: all zeros. So linearised column-major:
    //  [1,1,0,0, 1,1,0,0, 0,0,0,0, 0,0,0,0]
    // RLE: 0×0, then 2 ones, 2 zeros, 2 ones, 2 zeros, 8 zeros → "0,2,2,2,10"
    const expectedCounts = "0,2,2,2,10";
    const r = new MaskRasterizer(4, 4);
    r.decodeRLE(expectedCounts, [4, 4]);
    const back = r.encodeRLE();
    expect(back.counts).toBe(expectedCounts);
    expect(back.size).toEqual([4, 4]);
  });

  it("paint → encode → decode → re-encode is stable", () => {
    const r = new MaskRasterizer(64, 64);
    // Paint a tiny disc that we know lies inside the canvas bounds.
    r.paintBrush(32, 32, 6, "draw");
    const enc1 = r.encodeRLE();

    const r2 = new MaskRasterizer(64, 64);
    r2.decodeRLE(enc1.counts, enc1.size);
    const enc2 = r2.encodeRLE();
    expect(enc2.counts).toBe(enc1.counts);
    expect(enc2.size).toEqual(enc1.size);
  });

  it("erase mode removes painted pixels under the brush", () => {
    const r = new MaskRasterizer(32, 32);
    r.paintBrush(16, 16, 8, "draw");
    expect(r.hasAnyPixel()).toBe(true);
    // Erase with a slightly larger radius to fully clear the disc.
    r.paintBrush(16, 16, 12, "erase");
    expect(r.hasAnyPixel()).toBe(false);
  });

  it("clear() resets the canvas", () => {
    const r = new MaskRasterizer(16, 16);
    r.paintBrush(8, 8, 4, "draw");
    expect(r.hasAnyPixel()).toBe(true);
    r.clear();
    expect(r.hasAnyPixel()).toBe(false);
  });

  it("paintStroke connects multiple points with a thick line", () => {
    const r = new MaskRasterizer(64, 64);
    r.paintStroke([
      [10, 10],
      [50, 10],
    ], 4, "draw");
    expect(r.hasAnyPixel()).toBe(true);
  });

  it("decodeRLE refuses size mismatches", () => {
    const r = new MaskRasterizer(8, 8);
    // Trying to load a 4x4 mask into an 8x8 rasterizer must throw.
    expect(() => r.decodeRLE("0,16", [4, 4])).toThrow();
  });

  it("generation counter advances on each paint", () => {
    const r = new MaskRasterizer(16, 16);
    const g0 = r.generation;
    r.paintBrush(8, 8, 4, "draw");
    expect(r.generation).toBeGreaterThan(g0);
    const g1 = r.generation;
    r.clear();
    expect(r.generation).toBeGreaterThan(g1);
  });
});
