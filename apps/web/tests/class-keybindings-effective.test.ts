/**
 * effectiveBindings — pure helper that merges stored rows with the
 * idx-ASC seed. Mirrors the server's compose_effective_bindings so
 * the frontend can react instantly to optimistic updates without
 * waiting for the server round-trip.
 */
import { describe, expect, it } from "vitest";
import { effectiveBindings } from "@/lib/class-keybindings";
import type { ClassRow } from "@/api/classes";

function cls(id: string, idx: number): ClassRow {
  return { id, project_id: "p", name: id, color: "#000", idx } as ClassRow;
}

describe("effectiveBindings", () => {
  it("seeds first nine classes by idx when no stored rows", () => {
    const classes = [cls("a", 0), cls("b", 1), cls("c", 2)];
    expect(effectiveBindings([], classes)).toEqual({
      1: "a",
      2: "b",
      3: "c",
    });
  });

  it("stored rows take precedence over the seed", () => {
    const classes = [cls("a", 0), cls("b", 1), cls("c", 2)];
    const stored = [{ digit: 1, class_id: "c", source: "stored" as const }];
    const eff = effectiveBindings(stored, classes);
    expect(eff[1]).toBe("c");
  });

  it("seed skips classes already bound by a stored row (no duplicates)", () => {
    const classes = [cls("a", 0), cls("b", 1), cls("c", 2)];
    // Class "a" is bound at digit 5; seed must not also place it at 1.
    const stored = [{ digit: 5, class_id: "a", source: "stored" as const }];
    const eff = effectiveBindings(stored, classes);
    expect(eff[5]).toBe("a");
    // Digits 1 and 2 are filled from remaining classes (b, c) in idx order.
    expect(eff[1]).toBe("b");
    expect(eff[2]).toBe("c");
  });

  it("project with fewer than 9 classes leaves trailing digits empty", () => {
    const classes = [cls("a", 0), cls("b", 1)];
    const eff = effectiveBindings([], classes);
    expect(eff).toEqual({ 1: "a", 2: "b" });
    expect(eff[3]).toBeUndefined();
  });

  it("zero classes → empty map", () => {
    expect(effectiveBindings([], [])).toEqual({});
  });

  it("ignores stored rows for digits outside 1..9 (defensive)", () => {
    const classes = [cls("a", 0)];
    const stored = [
      { digit: 0, class_id: "a", source: "stored" as const },
      { digit: 10, class_id: "a", source: "stored" as const },
    ];
    // Out-of-range stored rows are ignored; seed still places "a" at 1.
    expect(effectiveBindings(stored, classes)).toEqual({ 1: "a" });
  });
});
