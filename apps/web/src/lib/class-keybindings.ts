// Armin Mehri — mehri.armin@gmail.com
/**
 * Pure merge of stored bindings + the first-nine-by-idx seed.
 * Mirrors the backend's compose_effective_bindings so optimistic
 * cache updates don't drift from the server's view.
 *
 *   1. Stored rows take precedence at their digit.
 *   2. Empty digits fall back to ``class.idx ASC LIMIT 9``, skipping
 *      classes already bound (no duplicate badges).
 *   3. Returns a {digit: classId} map; digits with no class are absent.
 */
import type { ClassRow } from "@/api/classes";
import type { ClassKeybinding } from "@/api/keybindings";

export function effectiveBindings(
  stored: ReadonlyArray<ClassKeybinding>,
  classes: ReadonlyArray<ClassRow>,
): Record<number, string> {
  const out: Record<number, string> = {};
  const storedByDigit = new Map<number, string>();
  const storedClassIds = new Set<string>();

  for (const row of stored) {
    if (row.digit < 1 || row.digit > 9) continue; // defensive
    storedByDigit.set(row.digit, row.class_id);
    storedClassIds.add(row.class_id);
  }

  const sortedClasses = [...classes].sort((a, b) => a.idx - b.idx);
  const seedPool = sortedClasses.filter((c) => !storedClassIds.has(c.id));

  let seedIdx = 0;
  for (let digit = 1; digit <= 9; digit += 1) {
    const storedForDigit = storedByDigit.get(digit);
    if (storedForDigit !== undefined) {
      out[digit] = storedForDigit;
      continue;
    }
    if (seedIdx < seedPool.length) {
      out[digit] = seedPool[seedIdx].id;
      seedIdx += 1;
    }
  }

  return out;
}
