// Armin Mehri — mehri.armin@gmail.com
import { Filter, Square, Pentagon, Brush, Tag, X, ChevronDown } from "lucide-react";
import { useAnnotations } from "@/state/annotations";
import { useFilter } from "@/state/annotationFilter";
import { evaluateFilter, hasMeaningfulRules } from "@/lib/annotation-filter";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/Popover";
import { useConfirm } from "@/components/ui/ConfirmDialog";
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

/**
 * Inline class-picker popover used in each annotation row. Lists every
 * class with a color chip + name; selecting one calls
 * ``useAnnotations.update(annId, { classId: nextId })`` which marks the
 * annotation dirty so the autosave flow persists the change.
 */
function ClassPickerPopover({
  annId,
  current,
  classes,
}: {
  annId: string;
  current: ClassRow | undefined;
  classes: ClassRow[];
}) {
  const update = useAnnotations((s) => s.update);
  const label = current?.name ?? "Unassigned";
  const swatch = current?.color ?? "#94A3B8";
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Change class for annotation (currently ${label})`}
          data-testid={`object-class-trigger-${annId}`}
          onClick={(e) => e.stopPropagation()}
          className={cn(
            "ml-auto inline-flex items-center gap-1 max-w-[110px] h-6 px-1.5",
            "rounded-[var(--radius-sm)] border border-[var(--glass-border)]",
            "bg-transparent text-[11px] tracking-tight text-[color:var(--text-secondary)]",
            "hover:border-[var(--border-strong)] hover:text-[color:var(--text-primary)]",
          )}
        >
          <span
            aria-hidden
            className="h-2.5 w-2.5 shrink-0 rounded-full border border-[var(--border-strong)]"
            style={{ background: swatch }}
          />
          <span className="truncate">{label}</span>
          <ChevronDown className="h-3 w-3 shrink-0 text-[color:var(--text-tertiary)]" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={4}
        className="grid gap-0.5 p-1 max-h-[260px] overflow-y-auto min-w-[180px]"
      >
        {classes.length === 0 && (
          <p className="px-2 py-1.5 text-[11px] italic text-[color:var(--text-tertiary)]">
            No classes defined.
          </p>
        )}
        {classes.map((c) => {
          const active = current?.id === c.id;
          return (
            <button
              key={c.id}
              type="button"
              data-testid={`object-class-option-${annId}-${c.id}`}
              onClick={(e) => {
                e.stopPropagation();
                if (!active) update(annId, { classId: c.id });
              }}
              className={cn(
                "flex items-center gap-2 px-2 py-1.5 rounded-[var(--radius-xs)] text-left",
                "text-[12px] tracking-tight cursor-pointer",
                active
                  ? "bg-[var(--accent-bg)] text-[color:var(--accent)]"
                  : "text-[color:var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[color:var(--text-primary)]",
              )}
            >
              <span
                aria-hidden
                className="h-3 w-3 shrink-0 rounded-full border border-[var(--border-strong)]"
                style={{ background: c.color }}
              />
              <span className="flex-1 truncate">{c.name}</span>
            </button>
          );
        })}
      </PopoverContent>
    </Popover>
  );
}

export function ObjectsPanel({ frameId, classes }: ObjectsPanelProps) {
  const byId = useAnnotations((s) => s.byId);
  const selectedId = useAnnotations((s) => s.selectedId);
  const select = useAnnotations((s) => s.select);
  const remove = useAnnotations((s) => s.remove);
  const filter = useFilter((s) => s.filter);
  const clearFilter = useFilter((s) => s.clearFilter);
  const confirm = useConfirm();

  const allOnFrame = Object.values(byId)
    .filter((a) => a.frameId === frameId)
    .sort((a, b) => a.tempId.localeCompare(b.tempId));

  const filterActive = hasMeaningfulRules(filter);
  const items = filterActive
    ? allOnFrame.filter((a) => evaluateFilter(a, classes ?? {}, filter))
    : allOnFrame;

  // Sorted list (by idx) of available classes — passed to every popover.
  // Computed once here so the row renders don't each rebuild it.
  const classList: ClassRow[] = classes
    ? Object.values(classes).sort((a, b) => a.idx - b.idx)
    : [];

  return (
    <section aria-label="Objects on this frame" className="grid gap-2">
      <header className="flex items-baseline justify-between">
        <h3 className="font-editorial text-[18px] leading-none text-[color:var(--text-primary)]">
          Objects
        </h3>
        <span className="font-mono-data text-[10px] text-tertiary tabular-tight">
          {items.length}
        </span>
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
          const cur = classes ? classes[a.classId] : undefined;
          return (
            // v2.9 P1-18 — non-interactive <li> + click was unreachable
            // by keyboard. role="button" + tabIndex + Enter/Space handler
            // mirrors a real button without disturbing the list visual.
            <li
              key={a.tempId}
              role="button"
              tabIndex={0}
              data-testid={`object-row-${a.tempId}`}
              onClick={() => select(a.tempId)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  select(a.tempId);
                }
              }}
              className={cn(
                "group flex items-center gap-2 rounded-[var(--radius-sm)] border px-2 py-1.5 cursor-pointer transition-colors",
                "focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]",
                isSelected
                  ? "bg-[var(--accent-bg)] border-[var(--border-accent)] text-primary"
                  : "bg-transparent border-transparent text-secondary hover:bg-[var(--bg-surface)] hover:text-primary",
              )}
            >
              <span aria-label={`${a.kind} icon`} className="text-tertiary shrink-0">
                <Icon className="h-3.5 w-3.5" />
              </span>
              <span className="text-[12px] tracking-tight shrink-0">{a.kind}</span>
              <ClassPickerPopover
                annId={a.tempId}
                current={cur}
                classes={classList}
              />
              <button
                type="button"
                aria-label={`Delete ${a.kind}`}
                title={`Delete ${a.kind} (Cmd+Z to undo)`}
                onClick={async (e) => {
                  // v2.9 P1-11 — replace the prior no-confirm flow with
                  // an in-app confirm dialog. Cmd+Z still undoes.
                  e.stopPropagation();
                  const ok = await confirm({
                    title: "Delete annotation?",
                    description:
                      "Press Cmd+Z to undo, or click Delete to remove.",
                    confirmLabel: "Delete",
                    variant: "danger",
                  });
                  if (ok) remove(a.tempId);
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
