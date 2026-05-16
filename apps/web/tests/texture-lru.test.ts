/**
 * Tests for the bounded Pixi texture LRU.
 *
 * Pins the invariants AnnotationCanvas relies on:
 *   - the just-touched URL is always the last element (== "currently
 *     bound" → never evicted on its own touch),
 *   - repeated touches of the same URL are idempotent in size,
 *   - oldest entries spill out in FIFO order once capacity is exceeded,
 *   - capacity=1 still works (degenerate but legal).
 */
import { describe, expect, it } from "vitest";
import { drainTextureLru, touchTextureLru } from "@/lib/texture-lru";

describe("touchTextureLru", () => {
  it("appends a fresh URL within capacity", () => {
    const r = touchTextureLru([], "a", 3);
    expect(r.order).toEqual(["a"]);
    expect(r.evicted).toEqual([]);
  });

  it("keeps the touched URL as the last element (MRU)", () => {
    const r = touchTextureLru(["a", "b"], "c", 3);
    expect(r.order).toEqual(["a", "b", "c"]);
    expect(r.evicted).toEqual([]);
  });

  it("promotes an existing URL to MRU without growing the list", () => {
    const r = touchTextureLru(["a", "b", "c"], "a", 3);
    expect(r.order).toEqual(["b", "c", "a"]);
    expect(r.evicted).toEqual([]);
  });

  it("evicts the oldest entry when adding past capacity", () => {
    const r = touchTextureLru(["a", "b", "c"], "d", 3);
    expect(r.order).toEqual(["b", "c", "d"]);
    expect(r.evicted).toEqual(["a"]);
  });

  it("evicts multiple oldest entries when the starting order is over capacity", () => {
    // Simulates a capacity reduction at runtime — the helper must
    // still drain down to capacity in a single call.
    const r = touchTextureLru(["a", "b", "c", "d"], "e", 3);
    expect(r.order).toEqual(["c", "d", "e"]);
    expect(r.evicted).toEqual(["a", "b"]);
  });

  it("never evicts the URL just touched (it is at the end)", () => {
    const r = touchTextureLru(["a", "b"], "b", 1);
    // Capacity=1; "b" was promoted; "a" gets evicted; "b" survives.
    expect(r.order).toEqual(["b"]);
    expect(r.evicted).toEqual(["a"]);
  });

  it("returns immutable inputs — does not mutate the source array", () => {
    const src = ["a", "b"];
    touchTextureLru(src, "c", 2);
    expect(src).toEqual(["a", "b"]);
  });

  it("rejects capacity < 1 (zero-cap would evict the just-loaded texture)", () => {
    expect(() => touchTextureLru([], "a", 0)).toThrow();
    expect(() => touchTextureLru([], "a", -3)).toThrow();
  });
});

describe("drainTextureLru", () => {
  it("returns every URL as evicted and an empty order", () => {
    const r = drainTextureLru(["a", "b", "c"]);
    expect(r.order).toEqual([]);
    expect(r.evicted).toEqual(["a", "b", "c"]);
  });

  it("is a no-op on an empty cache", () => {
    const r = drainTextureLru([]);
    expect(r.order).toEqual([]);
    expect(r.evicted).toEqual([]);
  });
});
