// Armin Mehri — mehri.armin@gmail.com
//
// v3.33 — companion to HierarchyResolverPanel. Drops the lower-
// confidence annotation when two UNRELATED classes overlap above an
// IoU floor. Targets the user-reported "motorbike tagged as racing
// car" case: SAM 3.1 multi-fragment text prompts ("Racing Car,
// Formula 1 Car, Formula E Car") sometimes match motorbikes; the
// hierarchy resolver can't fix this because Motorbike isn't in
// Racing Car's ancestor chain.
//
// Unlike HierarchyResolverPanel this panel is always available -- no
// hierarchy required. OFF by default; the user opts in per-run.
import type { ChangeEvent, ReactElement } from "react";

import { cn } from "@/lib/cn";
import { Checkbox } from "@/components/ui/Checkbox";

export interface CrossClassResolverPanelProps {
  enabled: boolean;
  onEnabledChange: (next: boolean) => void;
  iou: number;
  onIouChange: (next: number) => void;
  /** Stable prefix so multiple panels can render on the same page. */
  name: string;
}

export function CrossClassResolverPanel({
  enabled,
  onEnabledChange,
  iou,
  onIouChange,
  name,
}: CrossClassResolverPanelProps): ReactElement {
  function parseIou(e: ChangeEvent<HTMLInputElement>) {
    const n = Number(e.target.value);
    if (!Number.isFinite(n)) return;
    onIouChange(Math.max(0, Math.min(1, n)));
  }

  return (
    <div
      data-testid={`${name}-cross-class-panel`}
      className="rounded-[var(--radius-sm)] border border-[var(--border-subtle)] bg-[var(--bg-subtle)] p-3"
    >
      <div className="flex items-start justify-between gap-3">
        <label
          className="flex items-start gap-2 cursor-pointer text-[12.5px] text-[color:var(--text-primary)] leading-tight"
          title="Drops the lower-confidence annotation when two unrelated classes overlap. Skips parent/child pairs (those use the hierarchy resolver above)."
        >
          <Checkbox
            checked={enabled}
            onChange={(e) => onEnabledChange(e.target.checked)}
            data-testid={`${name}-cross-class-toggle`}
          />
          <span>Resolve cross-class overlaps (winner-takes-all)</span>
        </label>
        <div
          className={cn(
            "flex items-center gap-1 text-[11px] tabular-nums",
            enabled
              ? "text-[color:var(--text-primary)]"
              : "text-[color:var(--text-tertiary)]",
          )}
        >
          <span>IoU ≥</span>
          <input
            type="number"
            step="0.05"
            min={0}
            max={1}
            value={iou}
            onChange={parseIou}
            disabled={!enabled}
            data-testid={`${name}-cross-class-iou`}
            className={cn(
              "w-14 px-1.5 py-0.5 rounded-[var(--radius-xs)] border border-[var(--border-subtle)]",
              "bg-[var(--bg-app)] text-right",
              "disabled:opacity-50 disabled:cursor-not-allowed",
              "focus:outline-none focus:ring-1 focus:ring-[var(--accent)]",
            )}
          />
        </div>
      </div>
      <p
        className={cn(
          "mt-2 text-[11px] leading-snug",
          enabled
            ? "text-[color:var(--text-secondary)]"
            : "text-[color:var(--text-tertiary)]",
        )}
      >
        When two annotations of <em>different</em> classes overlap on the
        same object (e.g. Motorbike + Racing Car), the higher-confidence
        one wins. Pairs in the same parent / child chain are skipped —
        those are handled by the hierarchy resolver above.
      </p>
    </div>
  );
}
