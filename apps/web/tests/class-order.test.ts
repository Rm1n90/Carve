/**
 * Class ordering — creation order, not alphabetical.
 *
 * Armin reported the Filter dialog's "Label" dropdown showed classes
 * alphabetically, which was disorienting because users think about
 * their classes in the order they created them. The fix sorts by
 * ``ClassRow.idx`` (the canonical creation-order index).
 */

import { describe, expect, it } from "vitest";
import { sortClassesByCreationOrder } from "@/lib/class-order";

describe("sortClassesByCreationOrder", () => {
  it("sorts by idx ascending when every class has it", () => {
    const input = [
      { id: "c-3", name: "Bus", idx: 2 },
      { id: "c-1", name: "Apple", idx: 0 },
      { id: "c-2", name: "Zebra", idx: 1 },
    ];
    const sorted = sortClassesByCreationOrder(input);
    expect(sorted.map((c) => c.name)).toEqual(["Apple", "Zebra", "Bus"]);
  });

  it("preserves creation order regardless of alphabetical order", () => {
    // Specific to Armin's report: he had Bus among other classes and
    // expected to see them in the order they were created. Alphabetical
    // sort would put Bus before Car but Bus might have been created
    // last — creation order honours that.
    const input = [
      { id: "c-1", name: "Car", idx: 0 },
      { id: "c-2", name: "Person", idx: 1 },
      { id: "c-3", name: "Bus", idx: 2 },
    ];
    const sorted = sortClassesByCreationOrder(input);
    expect(sorted.map((c) => c.name)).toEqual(["Car", "Person", "Bus"]);
  });

  it("input array is not mutated (returns a fresh array)", () => {
    const input = [
      { id: "c-1", name: "Z", idx: 1 },
      { id: "c-2", name: "A", idx: 0 },
    ];
    const snapshot = input.map((c) => c.name);
    sortClassesByCreationOrder(input);
    expect(input.map((c) => c.name)).toEqual(snapshot);
  });

  it("falls back to name-sort when idx is missing (older / test callers)", () => {
    const input = [
      { id: "c-1", name: "Zebra" },
      { id: "c-2", name: "Apple" },
      { id: "c-3", name: "Mango" },
    ];
    const sorted = sortClassesByCreationOrder(input);
    expect(sorted.map((c) => c.name)).toEqual(["Apple", "Mango", "Zebra"]);
  });

  it("uses name-sort tiebreaker when idx values collide", () => {
    const input = [
      { id: "c-1", name: "Zoo", idx: 0 },
      { id: "c-2", name: "Apple", idx: 0 },
    ];
    const sorted = sortClassesByCreationOrder(input);
    expect(sorted.map((c) => c.name)).toEqual(["Apple", "Zoo"]);
  });

  it("handles empty input", () => {
    expect(sortClassesByCreationOrder([])).toEqual([]);
  });

  it("handles single-element input", () => {
    const input = [{ id: "c-1", name: "Bus", idx: 0 }];
    expect(sortClassesByCreationOrder(input)).toEqual(input);
  });

  it("partial idx coverage falls back to name-sort (deterministic)", () => {
    // Mixed: some classes have idx, some don't. The helper picks
    // name-sort as the deterministic fallback so the user never sees
    // a "random" ordering caused by stable-sort over undefined.
    const input = [
      { id: "c-1", name: "Zebra", idx: 0 },
      { id: "c-2", name: "Apple" }, // no idx
    ];
    const sorted = sortClassesByCreationOrder(input);
    expect(sorted.map((c) => c.name)).toEqual(["Apple", "Zebra"]);
  });
});
