// Armin Mehri — mehri.armin@gmail.com
//
// v3.31 — shared "Range: from N to M" scope helpers for the
// Auto-Annotate, Smart Find (YOLOE) and My Model (YOLO predict)
// dialogs. The user picks a 1-based asset position range against the
// current task's asset list; the helpers clamp / swap inputs, derive
// the resolved id list, and expose a single canRun check the dialogs
// can wire to their Run buttons.
//
// Asset positions are 1-based to match how a non-engineer reads the
// asset strip ("from asset 300 to 599" means the 300th through 599th
// asset in the canonical sort order — the same order the backend
// iterates with `select(Asset).order_by(Asset.created_at)`).

export type ScopeMode = "this" | "all" | "range";

export interface RangeInput {
  /** Raw 1-based "from" position as typed by the user. May be NaN,
   *  negative, or larger than the task's asset count. */
  from: number | "";
  /** Raw 1-based "to" position as typed by the user. May be NaN,
   *  negative, or larger than the task's asset count. */
  to: number | "";
}

export interface ClampedRange {
  /** 1-based start, clamped to [1, total]. */
  from: number;
  /** 1-based end, clamped to [from, total]. */
  to: number;
  /** True when the user typed something sensible (or we coerced it
   *  into something sensible). False when ``total`` is 0 so there is
   *  no valid range at all. */
  ok: boolean;
}

export interface RangeAssetsResult {
  /** UUIDs in canonical task order, inclusive of both endpoints. */
  ids: string[];
  /** The clamped 1-based range actually used (matches ``ids.length``
   *  by ``to - from + 1`` when ``ok``). */
  range: ClampedRange;
}

/**
 * Coerce raw text-input numbers into a valid 1-based [from, to] range
 * against a task that has ``total`` assets. Empty strings or NaN/Infinity
 * are treated as "missing endpoint" and replaced by the natural default
 * (``from`` → 1, ``to`` → ``total``). If the user swapped the endpoints
 * (typed from=599, to=300) we silently swap them back rather than
 * surfacing an error — matches how spreadsheet range pickers behave.
 *
 * Returns ``ok: false`` only when ``total <= 0``; the dialogs gate the
 * Run button on that.
 */
export function clampRange(
  input: RangeInput,
  total: number,
): ClampedRange {
  if (!Number.isFinite(total) || total <= 0) {
    return { from: 1, to: 1, ok: false };
  }
  const rawFrom =
    typeof input.from === "number" && Number.isFinite(input.from)
      ? Math.floor(input.from)
      : 1;
  const rawTo =
    typeof input.to === "number" && Number.isFinite(input.to)
      ? Math.floor(input.to)
      : total;
  const clamp = (n: number) => Math.max(1, Math.min(total, n));
  let from = clamp(rawFrom);
  let to = clamp(rawTo);
  if (from > to) {
    const t = from;
    from = to;
    to = t;
  }
  return { from, to, ok: true };
}

/**
 * Resolve a 1-based [from, to] range against an ordered asset id list
 * to the actual UUIDs the dialogs will send as ``asset_ids``.
 *
 * ``orderedAssetIds`` MUST be in the same order the backend iterates
 * (Asset.created_at ascending — that's the order the React Query
 * ``task-assets`` cache holds them).
 *
 * When the input is empty or ``total <= 0`` the returned ``ids`` is
 * empty and the dialog should block the Run button rather than firing
 * a no-op against the server.
 */
export function assetIdsFromRange(
  input: RangeInput,
  orderedAssetIds: ReadonlyArray<string>,
): RangeAssetsResult {
  const total = orderedAssetIds.length;
  const range = clampRange(input, total);
  if (!range.ok) {
    return { ids: [], range };
  }
  // slice is 0-based and exclusive on the end; range is 1-based and
  // inclusive on both ends. Convert with from-1 / to.
  const ids = orderedAssetIds.slice(range.from - 1, range.to);
  return { ids, range };
}

/**
 * Final "what should the wire body send as asset_ids?" helper.
 *
 * - mode="this": returns null (call site uses the single-asset
 *   endpoint or just runs the task-wide batch without a filter).
 * - mode="all": returns null (no filter — server iterates every
 *   asset).
 * - mode="range": returns the resolved id list (possibly empty when
 *   the task has zero assets; callers should guard).
 */
export function resolveScopeAssetIds(
  mode: ScopeMode,
  input: RangeInput,
  orderedAssetIds: ReadonlyArray<string>,
): string[] | null {
  if (mode !== "range") return null;
  return assetIdsFromRange(input, orderedAssetIds).ids;
}
