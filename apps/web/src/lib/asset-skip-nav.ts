// Armin Mehri — mehri.armin@gmail.com
/**
 * Skip-navigation helpers — "next empty" and "next unreviewed".
 *
 * For QA passes the user wants to fly past assets that are done and
 * land on the next one that needs attention. The two helpers below are
 * pure walkers over ``taskAssets`` keyed by counts derived from the
 * task-wide raw annotation list (the existing
 * ``["task-annotations-raw", taskId]`` query).
 *
 * Always ignore the active filter — "where's the work" is global; the
 * filter-aware ArrowLeft/Right path still handles "where does my
 * filter match". See spec
 * docs/superpowers/specs/2026-05-16-annotator-accelerators-design.md F2.
 */
import type { AnnotationRaw } from "@/api/annotations";

export type SkipDirection = "forward" | "backward";

/**
 * Map ``asset_id → annotation count`` and ``asset_id →
 * needs-work count`` (i.e. annotations whose status is not
 * ``accepted``). Computed once per call so a single pass over ``raw``
 * powers both predicates without re-walking N times.
 */
interface AssetCounts {
  total: number;
  needsWork: number;
}

function aggregate(raw: ReadonlyArray<AnnotationRaw>): Map<string, AssetCounts> {
  const out = new Map<string, AssetCounts>();
  for (const r of raw) {
    if (!r.asset_id) continue;
    const prev = out.get(r.asset_id);
    const needsWork = r.status !== "accepted" ? 1 : 0;
    if (prev) {
      prev.total += 1;
      prev.needsWork += needsWork;
    } else {
      out.set(r.asset_id, { total: 1, needsWork });
    }
  }
  return out;
}

function walk<A extends { id: string }>(
  assets: ReadonlyArray<A>,
  currentIdx: number,
  direction: SkipDirection,
  predicate: (a: A) => boolean,
): A | null {
  if (assets.length === 0) return null;
  const step = direction === "forward" ? 1 : -1;
  let i = currentIdx + step;
  while (i >= 0 && i < assets.length) {
    if (predicate(assets[i])) return assets[i];
    i += step;
  }
  return null;
}

/**
 * Find the next asset with **zero** annotations, walking from
 * ``currentIdx`` in ``direction``. Returns ``null`` when no candidate
 * exists ahead. The current asset itself is intentionally skipped —
 * if the user is on an empty asset, they want to advance to the
 * next one, not stay.
 */
export function findNextEmptyAsset<A extends { id: string }>(
  assets: ReadonlyArray<A>,
  raw: ReadonlyArray<AnnotationRaw>,
  currentIdx: number,
  direction: SkipDirection,
): A | null {
  const counts = aggregate(raw);
  return walk(assets, currentIdx, direction, (a) => {
    const c = counts.get(a.id);
    return !c || c.total === 0;
  });
}

/**
 * Find the next asset that still needs review — i.e. has at least one
 * annotation whose status is not ``accepted`` (proposed, rejected, or
 * missing-status). Empty assets do NOT match this predicate because
 * "no work" and "needs work" are different states and the user has
 * a dedicated skip for empties.
 */
export function findNextUnreviewedAsset<A extends { id: string }>(
  assets: ReadonlyArray<A>,
  raw: ReadonlyArray<AnnotationRaw>,
  currentIdx: number,
  direction: SkipDirection,
): A | null {
  const counts = aggregate(raw);
  return walk(assets, currentIdx, direction, (a) => {
    const c = counts.get(a.id);
    return Boolean(c && c.total > 0 && c.needsWork > 0);
  });
}
