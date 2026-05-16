// Armin Mehri — mehri.armin@gmail.com
/**
 * Filter-aware asset navigation.
 *
 * When the user submits an annotation filter (e.g. ``label == bus``)
 * pressing ArrowLeft/ArrowRight should jump to the next *matching*
 * asset — the one that actually contains a bus — instead of stepping
 * blindly through every asset in the task. Without this, users have
 * to flip through dozens of un-matching images to find the next one
 * that contains the class they're filtering for.
 *
 * Pure helpers (no React, no zustand). Consumed by
 * ``pages/AnnotateAssetPage.tsx``; covered by ``annotation-filter-nav.test.ts``.
 */
import type { AnnotationRaw } from "@/api/annotations";
import type { AnnotationDraft, Geometry } from "@/state/annotations";
import type { ClassRow } from "@/api/classes";
import {
  evaluateFilter,
  hasMeaningfulRules,
  type FilterGroup,
} from "@/lib/annotation-filter";

/** Adapter shape — anything the underlying ``evaluateFilter`` can read.
 *
 * The page hands us EITHER raw API rows (other assets, via the
 * task-wide query) OR live ``AnnotationDraft`` values from the local
 * Zustand store (current asset only). Both shapes carry the fields the
 * filter evaluator cares about (classId, kind, geometry, frameId), so
 * we accept either and normalise once before evaluation.
 */
type EvaluableAnnotation = Pick<
  AnnotationDraft,
  "classId" | "kind" | "geometry" | "frameId"
>;

/**
 * Build the set of asset IDs that contain at least one annotation
 * matching the supplied filter. Returns an empty set when:
 *   • the filter is null / has no meaningful rules
 *   • no annotation in the task matches
 *
 * Callers should fall back to the full asset list when the filter is
 * inactive (use ``hasMeaningfulRules`` to detect that case BEFORE
 * calling this).
 */
export function computeMatchingAssetIds(
  rawAnnotations: ReadonlyArray<AnnotationRaw>,
  classes: Record<string, ClassRow>,
  filter: FilterGroup | null,
): Set<string> {
  const matches = new Set<string>();
  if (!filter || !hasMeaningfulRules(filter)) return matches;

  for (const raw of rawAnnotations) {
    if (!raw.asset_id) continue;
    // Build a minimal AnnotationDraft-shaped value for the evaluator.
    // ``evaluateFilter`` reads only classId/kind/geometry/frameId, so
    // we leave the review-state fields at safe defaults. We DO NOT
    // mutate the raw value — the caller's list stays intact.
    const draft: AnnotationDraft = {
      tempId: raw.id,
      classId: raw.class_id,
      kind: raw.kind,
      geometry: raw.geometry as unknown as Geometry,
      frameId: raw.frame_id,
      serverId: raw.id,
      dirty: false,
      zOrder: 0,
      status: "proposed",
      reviewedById: null,
      reviewedAt: null,
      prevGeometry: null,
    };
    if (evaluateFilter(draft, classes, filter)) {
      matches.add(raw.asset_id);
    }
  }
  return matches;
}

/**
 * Given the ordered list of task assets and the index of the current
 * one, return the prev/next *matching* neighbours when ``matching`` is
 * non-empty. Falls back to plain adjacency (the un-filtered behaviour)
 * when ``matching`` is empty so navigation is never "stuck" — the
 * caller stays in control of when to invoke the filtered path.
 *
 * Notes:
 *   • The current asset itself is excluded — pressing Right always
 *     advances even when the current asset matches.
 *   • Single-match case: both prev and next can be null when only the
 *     current asset matches.
 *   • Mixed case: when the filter set is non-empty but the current
 *     asset is NOT in it, prev/next walk the matching subset in order,
 *     skipping over non-matching neighbours.
 */
export function computeFilteredNeighbours<A extends { id: string }>(
  taskAssets: ReadonlyArray<A>,
  currentAssetIdx: number,
  matching: ReadonlySet<string>,
): { prev: A | null; next: A | null } {
  if (taskAssets.length === 0) return { prev: null, next: null };
  // No active filter → preserve the existing plain-adjacency contract.
  if (matching.size === 0) {
    const prev = currentAssetIdx > 0 ? taskAssets[currentAssetIdx - 1] : null;
    const next =
      currentAssetIdx >= 0 && currentAssetIdx < taskAssets.length - 1
        ? taskAssets[currentAssetIdx + 1]
        : null;
    return { prev: prev ?? null, next: next ?? null };
  }

  // Walk backwards from the current index to find the previous matching
  // asset. ``currentAssetIdx - 1`` is the start; if the current asset
  // is itself off-list (idx == -1) we scan from the end.
  const start = currentAssetIdx < 0 ? taskAssets.length : currentAssetIdx;
  let prev: A | null = null;
  for (let i = start - 1; i >= 0; i -= 1) {
    const a = taskAssets[i];
    if (matching.has(a.id)) {
      prev = a;
      break;
    }
  }
  let next: A | null = null;
  for (let i = start + 1; i < taskAssets.length; i += 1) {
    const a = taskAssets[i];
    if (matching.has(a.id)) {
      next = a;
      break;
    }
  }
  return { prev, next };
}

/**
 * Re-compute the current asset's membership in ``matching`` from the
 * live in-memory annotations store (rather than the cached task-wide
 * query), and return a fresh Set with that single override applied.
 *
 * Why this exists: the cached server query is the authority for OTHER
 * assets, but for the asset the user is currently editing the local
 * store is fresher — it reflects deletes/adds the millisecond they
 * happen, before autosave has had a chance to flush. Without this
 * override, deleting the last Bus on the current asset would leave
 * that asset in the matching set, so arrow navigation would still
 * land on it (the bug Armin reported).
 *
 * The other-assets membership is preserved verbatim. If the user
 * adds a matching annotation locally, the current asset gets added
 * to the set; if they delete the last match, it's removed.
 *
 * Pass ``currentAssetId = null`` (e.g. between asset switches) to
 * disable the override and return ``matching`` unchanged.
 */
export function applyLocalAssetOverride(
  matching: ReadonlySet<string>,
  currentAssetId: string | null,
  currentAssetAnnotations: ReadonlyArray<EvaluableAnnotation>,
  classes: Record<string, ClassRow>,
  filter: FilterGroup | null,
): Set<string> {
  const next = new Set(matching);
  if (!currentAssetId) return next;
  if (!filter || !hasMeaningfulRules(filter)) return next;
  let anyMatch = false;
  for (const ann of currentAssetAnnotations) {
    // Build the minimal AnnotationDraft shape the evaluator needs.
    // We tolerate either raw rows (server-shaped) or live drafts.
    const draft: AnnotationDraft = {
      tempId: "",
      classId: ann.classId,
      kind: ann.kind,
      geometry: ann.geometry as unknown as Geometry,
      frameId: ann.frameId,
      serverId: null,
      dirty: false,
      zOrder: 0,
      status: "proposed",
      reviewedById: null,
      reviewedAt: null,
      prevGeometry: null,
    };
    if (evaluateFilter(draft, classes, filter)) {
      anyMatch = true;
      break;
    }
  }
  if (anyMatch) {
    next.add(currentAssetId);
  } else {
    next.delete(currentAssetId);
  }
  return next;
}
