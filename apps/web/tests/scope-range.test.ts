// Armin Mehri — mehri.armin@gmail.com
//
// v3.31 — unit tests for the shared scope-range helpers used by the
// Auto-Annotate / Smart Find / My Model dialogs. The helpers are pure
// so we lean hard on edge cases: empty inputs, NaN, swapped endpoints,
// out-of-bound clamps, fractional inputs, and the all-empty task case
// (so the dialogs can disable Run instead of firing a no-op batch).
import { describe, expect, it } from "vitest";

import {
  assetIdsFromRange,
  clampRange,
  resolveScopeAssetIds,
} from "@/lib/scopeRange";

function ids(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `asset-${i + 1}`);
}

describe("clampRange", () => {
  it("defaults missing endpoints to [1, total]", () => {
    expect(clampRange({ from: "", to: "" }, 10)).toEqual({
      from: 1,
      to: 10,
      ok: true,
    });
  });

  it("clamps below 1 up to 1", () => {
    expect(clampRange({ from: -42, to: 5 }, 10)).toEqual({
      from: 1,
      to: 5,
      ok: true,
    });
  });

  it("clamps above total down to total", () => {
    expect(clampRange({ from: 3, to: 9_999 }, 10)).toEqual({
      from: 3,
      to: 10,
      ok: true,
    });
  });

  it("swaps reversed endpoints (from > to)", () => {
    expect(clampRange({ from: 8, to: 2 }, 10)).toEqual({
      from: 2,
      to: 8,
      ok: true,
    });
  });

  it("floors fractional inputs (300.7 -> 300)", () => {
    expect(clampRange({ from: 300.7, to: 599.2 }, 1000)).toEqual({
      from: 300,
      to: 599,
      ok: true,
    });
  });

  it("treats NaN as missing endpoint", () => {
    expect(clampRange({ from: Number.NaN, to: 5 }, 10)).toEqual({
      from: 1,
      to: 5,
      ok: true,
    });
  });

  it("returns ok:false when the task has zero assets", () => {
    expect(clampRange({ from: 1, to: 5 }, 0)).toEqual({
      from: 1,
      to: 1,
      ok: false,
    });
  });

  it("collapses [from=to] to a single-element range", () => {
    expect(clampRange({ from: 5, to: 5 }, 10)).toEqual({
      from: 5,
      to: 5,
      ok: true,
    });
  });
});

describe("assetIdsFromRange", () => {
  it("resolves a 1-based range to the inclusive slice", () => {
    const r = assetIdsFromRange({ from: 2, to: 4 }, ids(10));
    expect(r.ids).toEqual(["asset-2", "asset-3", "asset-4"]);
    expect(r.range).toEqual({ from: 2, to: 4, ok: true });
  });

  it("clamps + slices when the user types 300..599 against 600 assets", () => {
    const list = ids(600);
    const r = assetIdsFromRange({ from: 300, to: 599 }, list);
    expect(r.ids.length).toBe(300);
    expect(r.ids[0]).toBe("asset-300");
    expect(r.ids[299]).toBe("asset-599");
    expect(r.range).toEqual({ from: 300, to: 599, ok: true });
  });

  it("returns the full list when both endpoints are empty", () => {
    const r = assetIdsFromRange({ from: "", to: "" }, ids(5));
    expect(r.ids).toEqual(["asset-1", "asset-2", "asset-3", "asset-4", "asset-5"]);
  });

  it("returns [] when the task has zero assets", () => {
    const r = assetIdsFromRange({ from: 1, to: 5 }, []);
    expect(r.ids).toEqual([]);
    expect(r.range.ok).toBe(false);
  });

  it("swaps reversed endpoints and still returns the inclusive slice", () => {
    const r = assetIdsFromRange({ from: 5, to: 2 }, ids(10));
    expect(r.ids).toEqual(["asset-2", "asset-3", "asset-4", "asset-5"]);
  });

  it("clamps negative from to 1 and over-the-top to to last index", () => {
    const r = assetIdsFromRange({ from: -10, to: 9_999 }, ids(3));
    expect(r.ids).toEqual(["asset-1", "asset-2", "asset-3"]);
  });
});

describe("resolveScopeAssetIds", () => {
  it("returns null for mode='this'", () => {
    expect(resolveScopeAssetIds("this", { from: 1, to: 2 }, ids(5))).toBeNull();
  });

  it("returns null for mode='all'", () => {
    expect(resolveScopeAssetIds("all", { from: 1, to: 2 }, ids(5))).toBeNull();
  });

  it("returns the slice for mode='range'", () => {
    expect(
      resolveScopeAssetIds("range", { from: 1, to: 2 }, ids(5)),
    ).toEqual(["asset-1", "asset-2"]);
  });

  it("returns an empty array for mode='range' when the task is empty", () => {
    expect(resolveScopeAssetIds("range", { from: 1, to: 2 }, [])).toEqual([]);
  });
});
