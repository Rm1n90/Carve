/**
 * Annotation filter — CVAT-style rule tree evaluation.
 *
 * The filter is a tree of rules and groups. Each rule compares one
 * field of an annotation against a value with an operator. Groups
 * combine their children with AND or OR; rules can be negated via
 * `not`. Trees serialize cleanly to JSON for the recently-used cache.
 *
 * Pure functions only — no React, no zustand. Callers (the canvas
 * shape renderer + the Objects panel) invoke `evaluateFilter` per
 * annotation per render to decide visibility.
 */
import type { AnnotationDraft } from "@/state/annotations";
import type { ClassRow } from "@/api/classes";

export type FilterField = "label" | "kind" | "width" | "height" | "obj_id";
export type FilterOp = "==" | "!=" | "<" | ">" | "<=" | ">=";

export interface FilterRule {
  not: boolean;
  field: FilterField;
  op: FilterOp;
  value: string | number;
}

export interface FilterGroup {
  combinator: "AND" | "OR";
  rules: (FilterRule | FilterGroup)[];
}

/**
 * Detect whether a node is a group (vs. a rule). Used by the recursive
 * walker so we can avoid `instanceof` and keep the tree pure JSON.
 */
export function isFilterGroup(
  node: FilterRule | FilterGroup,
): node is FilterGroup {
  return (node as FilterGroup).combinator !== undefined;
}

const NUMERIC_FIELDS: ReadonlySet<FilterField> = new Set([
  "width",
  "height",
]);

/** Build a fresh empty rule (used by the dialog for "+ Add rule"). */
export function makeEmptyRule(): FilterRule {
  return { not: false, field: "label", op: "==", value: "" };
}

/** Build a fresh empty group with a single empty rule inside. */
export function makeEmptyGroup(): FilterGroup {
  return { combinator: "AND", rules: [makeEmptyRule()] };
}

/**
 * Returns the field's value for a single annotation. `null` means the
 * field can't be computed (e.g. tag has no width/height) — callers
 * treat null as "not matching" for any operator.
 */
export function getFieldValue(
  annotation: AnnotationDraft,
  classes: Record<string, ClassRow>,
  field: FilterField,
): string | number | null {
  switch (field) {
    case "label": {
      const cls = classes[annotation.classId];
      return cls?.name ?? "";
    }
    case "kind":
      return annotation.kind;
    case "obj_id":
      return annotation.serverId ?? annotation.tempId;
    case "width":
    case "height": {
      const dims = computeBboxDims(annotation);
      if (!dims) return null;
      return field === "width" ? dims.w : dims.h;
    }
  }
}

interface Dims {
  w: number;
  h: number;
}

/** Compute the bounding-rect width/height of any geometry (tag → 0). */
function computeBboxDims(annotation: AnnotationDraft): Dims | null {
  const g = annotation.geometry;
  if (g.kind === "bbox") return { w: g.w, h: g.h };
  if (g.kind === "polygon") {
    if (g.points.length === 0) return { w: 0, h: 0 };
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const [x, y] of g.points) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
    return { w: maxX - minX, h: maxY - minY };
  }
  if (g.kind === "mask_rle") {
    const [h, w] = g.size;
    return { w, h };
  }
  // tag → 0×0
  return { w: 0, h: 0 };
}

/**
 * Compare two values with the rule's operator. Numeric fields coerce
 * the rule value to a number; string fields compare lexicographically
 * for ordering ops. Empty rule values match nothing — the dialog
 * filters those before submit, but we guard here too.
 */
function compare(
  fieldValue: string | number,
  op: FilterOp,
  ruleValue: string | number,
  field: FilterField,
): boolean {
  if (NUMERIC_FIELDS.has(field)) {
    const a = typeof fieldValue === "number" ? fieldValue : Number(fieldValue);
    const b = typeof ruleValue === "number" ? ruleValue : Number(ruleValue);
    if (Number.isNaN(a) || Number.isNaN(b)) return false;
    switch (op) {
      case "==":
        return a === b;
      case "!=":
        return a !== b;
      case "<":
        return a < b;
      case ">":
        return a > b;
      case "<=":
        return a <= b;
      case ">=":
        return a >= b;
    }
  }
  // String fields: case-insensitive equality, lexicographic ordering
  // for relative ops (rarely useful but consistent with CVAT).
  const a = String(fieldValue).toLowerCase();
  const b = String(ruleValue).toLowerCase();
  switch (op) {
    case "==":
      return a === b;
    case "!=":
      return a !== b;
    case "<":
      return a < b;
    case ">":
      return a > b;
    case "<=":
      return a <= b;
    case ">=":
      return a >= b;
  }
}

/** Evaluate one rule against one annotation. */
function evaluateRule(
  annotation: AnnotationDraft,
  classes: Record<string, ClassRow>,
  rule: FilterRule,
): boolean {
  // Skip rules with empty values — the dialog displays them but they
  // shouldn't filter anything until the user enters a value. Without
  // this, "label == <empty>" would hide every annotation.
  if (rule.value === "" || rule.value === null || rule.value === undefined) {
    return true;
  }
  const fv = getFieldValue(annotation, classes, rule.field);
  if (fv === null) return rule.not; // can't compute → fail predicate
  const matched = compare(fv, rule.op, rule.value, rule.field);
  return rule.not ? !matched : matched;
}

/**
 * Walk the tree returning whether the annotation matches the filter.
 * Empty groups (no rules) match everything — callers can pass `null`
 * to mean "no filter active" instead.
 */
export function evaluateFilter(
  annotation: AnnotationDraft,
  classes: Record<string, ClassRow>,
  group: FilterGroup | null,
): boolean {
  if (!group) return true;
  if (group.rules.length === 0) return true;
  if (group.combinator === "AND") {
    for (const child of group.rules) {
      const ok = isFilterGroup(child)
        ? evaluateFilter(annotation, classes, child)
        : evaluateRule(annotation, classes, child);
      if (!ok) return false;
    }
    return true;
  }
  // OR
  for (const child of group.rules) {
    const ok = isFilterGroup(child)
      ? evaluateFilter(annotation, classes, child)
      : evaluateRule(annotation, classes, child);
    if (ok) return true;
  }
  return false;
}

/**
 * Returns true when the group has at least one rule with a non-empty
 * value. Used by callers to know whether to actually apply the filter
 * or skip it (e.g. don't render the "Filter active" pill when the
 * tree only contains empty rules).
 */
export function hasMeaningfulRules(group: FilterGroup | null): boolean {
  if (!group) return false;
  for (const child of group.rules) {
    if (isFilterGroup(child)) {
      if (hasMeaningfulRules(child)) return true;
    } else {
      const v = child.value;
      if (v !== "" && v !== null && v !== undefined) return true;
    }
  }
  return false;
}
