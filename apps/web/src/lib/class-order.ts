// Armin Mehri — mehri.armin@gmail.com
/**
 * Class ordering helpers.
 *
 * The Filter dialog's "Label" dropdown shows project classes. Armin
 * reported alphabetical ordering felt disorienting because users think
 * of their classes in CREATION ORDER (same as the Classes panel). The
 * server's ``ClassRow.idx`` is the canonical creation-order index;
 * sort by it when present, fall back to name-sort so tests and older
 * callers that don't provide ``idx`` still work.
 */

export interface OrderableClass {
  id: string;
  name: string;
  idx?: number;
}

/**
 * Return a fresh array sorted by creation order. When every input has
 * ``idx``, sorts strictly by ``idx`` ascending. When ``idx`` is
 * missing on any entry, falls back to case-sensitive name-sort so the
 * order is deterministic.
 */
export function sortClassesByCreationOrder<C extends OrderableClass>(
  classes: ReadonlyArray<C>,
): C[] {
  const hasIdx = classes.every((c) => typeof c.idx === "number");
  return [...classes].sort((a, b) => {
    if (hasIdx) {
      const ai = a.idx as number;
      const bi = b.idx as number;
      if (ai !== bi) return ai - bi;
    }
    return a.name.localeCompare(b.name);
  });
}
