import { Filter, Square, Pentagon, Brush, Tag, X } from "lucide-react";
import { useAnnotations } from "@/state/annotations";
import { useFilter } from "@/state/annotationFilter";
import { evaluateFilter, hasMeaningfulRules } from "@/lib/annotation-filter";
import type { ClassRow } from "@/api/classes";
import { cn } from "@/lib/cn";

const KIND_ICON = {
  bbox: Square,
  polygon: Pentagon,
  mask: Brush,
  tag: Tag,
} as const;

interface ObjectsPanelProps {
  frameId: string | null;
  /**
   * Class lookup keyed by class id. Optional — when omitted, label-field
   * filter rules silently match nothing because they can't resolve the
   * annotation's class name. Page-level callers pass the full map.
   */
  classes?: Record<string, ClassRow>;
}

export function ObjectsPanel({ frameId, classes }: ObjectsPanelProps) {
  const byId = useAnnotations((s) => s.byId);
  const selectedId = useAnnotations((s) => s.selectedId);
  const select = useAnnotations((s) => s.select);
  const remove = useAnnotations((s) => s.remove);
  const filter = useFilter((s) => s.filter);
  const clearFilter = useFilter((s) => s.clearFilter);

  const allOnFrame = Object.values(byId)
    .filter((a) => a.frameId === frameId)
    .sort((a, b) => a.tempId.localeCompare(b.tempId));

  const filterActive = hasMeaningfulRules(filter);
  const items = filterActive
    ? allOnFrame.filter((a) => evaluateFilter(a, classes ?? {}, filter))
    : allOnFrame;

  return (
    <section aria-label="Objects on this frame" className="grid gap-2">
      <header className="flex items-center justify-between">
        <h3 className="text-[11px] uppercase tracking-[0.10em] text-tertiary font-medium">
          Objects
        </h3>
        <span className="font-mono-data text-[10px] text-tertiary">{items.length}</span>
      </header>
      {filterActive && (
        <div
          data-testid="filter-active-pill"
          className="flex items-center justify-between gap-2 rounded-[var(--radius-sm)] border border-[var(--accent)] bg-[var(--accent-bg)] px-2 py-1"
        >
          <span className="inline-flex items-center gap-1.5 text-[11px] font-medium tracking-tight text-[color:var(--accent)]">
            <Filter className="h-3 w-3" />
            Filter active ({items.length} of {allOnFrame.length} shown)
          </span>
          <button
            type="button"
            aria-label="Clear filter"
            data-testid="filter-active-clear"
            onClick={clearFilter}
            className="grid h-5 w-5 place-items-center rounded-[var(--radius-sm)] text-[color:var(--accent)] hover:bg-[var(--bg-hover)] transition-colors"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      )}
      {items.length === 0 && (
        <p className="text-tertiary text-[12px] italic">
          {filterActive
            ? "No annotations match the current filter."
            : "No annotations yet on this frame."}
        </p>
      )}
      <ul className="grid gap-1">
        {items.map((a) => {
          const Icon = (KIND_ICON as Record<string, typeof Square>)[a.kind] ?? Square;
          const isSelected = a.tempId === selectedId;
          return (
            <li
              key={a.tempId}
              onClick={() => select(a.tempId)}
              className={cn(
                "group flex items-center gap-2.5 rounded-[var(--radius-sm)] border px-2.5 py-1.5 cursor-pointer transition-colors",
                isSelected
                  ? "bg-[var(--accent-bg)] border-[var(--border-accent)] text-primary"
                  : "bg-transparent border-transparent text-secondary hover:bg-[var(--bg-surface)] hover:text-primary",
              )}
            >
              <span aria-label={`${a.kind} icon`} className="text-tertiary">
                <Icon className="h-3.5 w-3.5" />
              </span>
              <span className="flex-1 text-[12px] tracking-tight">{a.kind}</span>
              <button
                type="button"
                aria-label={`Delete ${a.kind}`}
                onClick={(e) => {
                  e.stopPropagation();
                  if (confirm(`Delete this ${a.kind}?`)) remove(a.tempId);
                }}
                className="grid h-6 w-6 place-items-center rounded-[var(--radius-sm)] text-tertiary opacity-0 transition-opacity group-hover:opacity-100 hover:bg-[oklch(0.70_0.20_25_/_0.10)] hover:text-[color:var(--danger)]"
              >
                <X className="h-3 w-3" />
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
