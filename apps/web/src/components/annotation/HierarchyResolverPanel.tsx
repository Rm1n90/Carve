// Armin Mehri — mehri.armin@gmail.com
//
// v3.31 — shared "Resolve hierarchical overlaps" panel for batch
// dialogs (Auto-Annotate, Smart Find, My Model). Renders:
//
//   ☑ Resolve hierarchical overlaps                 IoU ≥ 0.70
//     Drops Car boxes overlapping Racing Car. 3 hierarchies in project.
//
// The component is presentational; the parent owns the toggle + IoU
// state and persistence. When no project class has a parent set, the
// toggle is rendered disabled with a one-line hint pointing the user
// at the Classes editor so the feature is discoverable but never
// silently no-ops.
import type { ChangeEvent, ReactElement } from "react";

import type { ClassRow } from "@/api/classes";
import { cn } from "@/lib/cn";
import { Checkbox } from "@/components/ui/Checkbox";

export interface HierarchyResolverPanelProps {
  /** Project classes used to count how many hierarchies exist. */
  classes: ReadonlyArray<ClassRow>;
  enabled: boolean;
  onEnabledChange: (next: boolean) => void;
  iou: number;
  onIouChange: (next: number) => void;
  /** Stable prefix so multiple panels can render on the same page. */
  name: string;
}

/**
 * Count how many parent → child relationships exist in the project.
 * Used to gate the toggle and surface "N hierarchies active" in the
 * helper text.
 */
function countHierarchies(classes: ReadonlyArray<ClassRow>): number {
  return classes.reduce(
    (acc, c) => (c.parent_class_id ? acc + 1 : acc),
    0,
  );
}

/**
 * Find a representative parent / child pair so the helper text shows
 * a concrete example ("Drops Car boxes overlapping Racing Car"). Falls
 * back to a generic phrase when no example can be derived.
 */
function representativePair(
  classes: ReadonlyArray<ClassRow>,
): { parent: string; child: string } | null {
  const byId = new Map(classes.map((c) => [c.id, c]));
  for (const child of classes) {
    if (!child.parent_class_id) continue;
    const parent = byId.get(child.parent_class_id);
    if (parent) return { parent: parent.name, child: child.name };
  }
  return null;
}

export function HierarchyResolverPanel({
  classes,
  enabled,
  onEnabledChange,
  iou,
  onIouChange,
  name,
}: HierarchyResolverPanelProps): ReactElement {
  const count = countHierarchies(classes);
  const available = count > 0;
  const example = representativePair(classes);

  function parseIou(e: ChangeEvent<HTMLInputElement>) {
    const n = Number(e.target.value);
    if (!Number.isFinite(n)) return;
    onIouChange(Math.max(0, Math.min(1, n)));
  }

  return (
    <div
      data-testid={`${name}-hierarchy-panel`}
      className={cn(
        "grid gap-1.5 rounded-[var(--radius-sm)] border border-[var(--border-subtle)] px-2.5 py-2",
        available
          ? "bg-[var(--bg-subtle)]"
          : "bg-transparent opacity-70",
      )}
    >
      <label
        className={cn(
          "flex items-center gap-2 text-[12.5px]",
          available ? "cursor-pointer" : "cursor-not-allowed",
        )}
        title={
          available
            ? "When a class has a parent class set (in the Classes editor), an ancestor's annotation that overlaps a descendant's above the IoU floor is dropped. Solves the Racing Car / Car double-label problem."
            : "No parent classes set yet. Open the Classes editor and assign a parent to any class to enable this."
        }
      >
        <Checkbox
          checked={enabled && available}
          onChange={(e) => onEnabledChange(e.target.checked)}
          disabled={!available}
          data-testid={`${name}-hierarchy-toggle`}
        />
        <span className="flex-1 font-medium text-[color:var(--text-primary)]">
          Resolve hierarchical overlaps
        </span>
        {available && enabled && (
          <span className="font-mono tabular-nums text-[11px] text-[color:var(--text-secondary)]">
            IoU &ge; {iou.toFixed(2)}
          </span>
        )}
      </label>
      {available && enabled && (
        <input
          type="range"
          min={0.3}
          max={0.95}
          step={0.05}
          value={iou}
          onChange={parseIou}
          aria-label="Hierarchy overlap IoU threshold"
          data-testid={`${name}-hierarchy-iou`}
          className="w-full accent-[var(--accent)]"
        />
      )}
      <p
        className="text-[11px] leading-snug text-[color:var(--text-tertiary)]"
        data-testid={`${name}-hierarchy-hint`}
      >
        {available && example ? (
          <>
            Drops <span className="font-medium">{example.parent}</span> boxes
            overlapping <span className="font-medium">{example.child}</span>{" "}
            (and any other ancestor/descendant pair).{" "}
            <span className="font-mono tabular-nums">{count}</span>{" "}
            {count === 1 ? "hierarchy" : "hierarchies"} active in this project.
          </>
        ) : available ? (
          <>
            Drops ancestor-class boxes that overlap a descendant-class box
            above the threshold.{" "}
            <span className="font-mono tabular-nums">{count}</span>{" "}
            {count === 1 ? "hierarchy" : "hierarchies"} active in this project.
          </>
        ) : (
          <>
            Add a parent class in the{" "}
            <span className="italic">Classes editor</span> (e.g. set
            "Racing Car"'s parent to "Car") to enable this. Saves you the
            duplicate-label cleanup pass at training time.
          </>
        )}
      </p>
    </div>
  );
}
