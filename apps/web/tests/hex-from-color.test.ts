import { describe, expect, it, vi } from "vitest";

// AnnotationCanvas's transitive imports include pixi.js (only via dynamic
// imports in the render path) and pixi.js types via @/canvas/ShapeRenderer.
// To keep this test light, mock pixi.js with a minimal stub.
vi.mock("pixi.js", () => ({
  Container: class {},
  Graphics: class {},
  Text: class {},
  Sprite: class {},
  Application: class {},
  Assets: { load: vi.fn() },
}));

import { hexFromColor } from "@/components/annotation/AnnotationCanvas";

const DEFAULT_AMBER = 0xeab308;

describe("hexFromColor (audit bug Q — defensive fallback)", () => {
  it("parses a #RRGGBB hex string", () => {
    expect(hexFromColor("#ff0000")).toBe(0xff0000);
    expect(hexFromColor("#00ff00")).toBe(0x00ff00);
    expect(hexFromColor("#0000ff")).toBe(0x0000ff);
  });

  it("parses a bare RRGGBB hex string (no leading #)", () => {
    expect(hexFromColor("ff0000")).toBe(0xff0000);
  });

  it("trims surrounding whitespace before parsing", () => {
    expect(hexFromColor("  #abcdef  ")).toBe(0xabcdef);
  });

  it("returns amber when the input is undefined", () => {
    expect(hexFromColor(undefined)).toBe(DEFAULT_AMBER);
  });

  it("returns amber when the input is the empty string", () => {
    expect(hexFromColor("")).toBe(DEFAULT_AMBER);
  });

  it("returns amber for OKLCH var values the regex cannot parse", () => {
    // SwatchPalette emits CSS variable references like "var(--swatch-3)"
    // which cannot be parsed as a #RRGGBB string. The renderer must fall
    // back to amber instead of NaN-ing the Pixi color.
    expect(hexFromColor("var(--swatch-3)")).toBe(DEFAULT_AMBER);
    expect(hexFromColor("oklch(0.7 0.15 150)")).toBe(DEFAULT_AMBER);
  });

  it("returns amber for malformed hex (wrong length)", () => {
    expect(hexFromColor("#fff")).toBe(DEFAULT_AMBER);
    expect(hexFromColor("#ff")).toBe(DEFAULT_AMBER);
    expect(hexFromColor("#fffffff")).toBe(DEFAULT_AMBER);
  });

  it("returns amber for hex with non-hex digits", () => {
    expect(hexFromColor("#zzzzzz")).toBe(DEFAULT_AMBER);
    expect(hexFromColor("#gg0000")).toBe(DEFAULT_AMBER);
  });
});
