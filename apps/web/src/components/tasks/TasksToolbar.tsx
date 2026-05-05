// Armin Mehri — mehri.armin@gmail.com
import { Search, X, Plus } from "lucide-react";
import { cn } from "@/lib/cn";

/**
 * Plan 14 Phase 8 Task 2 — sticky toolbar for the project detail's
 * Tasks tab. Owns search, status, sort, and "New task" controls.
 */
export type TaskStatusFilter = "all" | "active" | "archived";
export type TaskSort = "updated-desc" | "name-asc";

interface Props {
  query: string;
  onQueryChange: (q: string) => void;
  status: TaskStatusFilter;
  onStatusChange: (s: TaskStatusFilter) => void;
  sort: TaskSort;
  onSortChange: (s: TaskSort) => void;
  onNewTask: () => void;
}

const STATUS_CHIPS: { value: TaskStatusFilter; label: string }[] = [
  { value: "active", label: "Active" },
  { value: "archived", label: "Archived" },
  { value: "all", label: "All" },
];

const SORT_OPTIONS: { value: TaskSort; label: string }[] = [
  { value: "updated-desc", label: "Updated (newest)" },
  { value: "name-asc", label: "Name (A-Z)" },
];

export function TasksToolbar({
  query,
  onQueryChange,
  status,
  onStatusChange,
  sort,
  onSortChange,
  onNewTask,
}: Props) {
  return (
    <div
      data-testid="tasks-toolbar"
      className={cn(
        "sticky top-0 z-10 grid gap-2 py-2",
        "bg-[var(--bg-app)]/85 backdrop-blur-md",
        "border-b border-[var(--border-subtle)]",
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[200px] flex-1">
          <Search
            className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-[color:var(--text-tertiary)] pointer-events-none"
            aria-hidden
          />
          <input
            type="search"
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            placeholder="Search tasks…"
            data-testid="tasks-toolbar-search"
            aria-label="Search tasks"
            className={cn(
              "w-full h-8 pl-8 pr-8 rounded-[var(--radius-sm)]",
              "bg-[var(--bg-elev)] text-[color:var(--text-primary)] placeholder:text-[color:var(--text-tertiary)]",
              "border border-[var(--border-subtle)] text-[12.5px]",
              "focus:outline-none focus:border-[var(--accent)]",
            )}
          />
          {query && (
            <button
              type="button"
              onClick={() => onQueryChange("")}
              data-testid="tasks-toolbar-search-clear"
              aria-label="Clear search"
              className="absolute right-2 top-1/2 -translate-y-1/2 grid h-5 w-5 place-items-center rounded-[var(--radius-xs)] text-[color:var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[color:var(--text-primary)]"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>

        <select
          value={sort}
          onChange={(e) => onSortChange(e.target.value as TaskSort)}
          data-testid="tasks-toolbar-sort"
          aria-label="Sort tasks"
          className={cn(
            "h-8 px-2 rounded-[var(--radius-sm)]",
            "bg-[var(--bg-elev)] text-[color:var(--text-primary)]",
            "border border-[var(--border-subtle)] text-[12px]",
            "focus:outline-none focus:border-[var(--accent)]",
          )}
        >
          {SORT_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>

        <button
          type="button"
          onClick={onNewTask}
          data-testid="tasks-toolbar-new"
          className={cn(
            // DESIGN.md §4 — primary CTA carries the full PS hover
            // signature: cyan fill, 2px white border, 2px PS-blue ring,
            // 1.05× lift, 180ms ease.
            "inline-flex items-center gap-1 h-8 px-3 rounded-[var(--radius-pill)]",
            "bg-[var(--accent)] text-[color:var(--accent-fg)] text-[12.5px] font-medium",
            "border border-[var(--accent)]",
            "transition-all duration-[180ms] ease-out",
            "hover:bg-[var(--accent-hover)] hover:border-white",
            "hover:shadow-[0_0_0_2px_var(--accent)] hover:scale-[1.05]",
            "active:opacity-60 active:scale-100",
          )}
        >
          <Plus className="h-3.5 w-3.5" />
          New task
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {STATUS_CHIPS.map((chip) => {
          const active = chip.value === status;
          return (
            <button
              key={chip.value}
              type="button"
              onClick={() => onStatusChange(chip.value)}
              data-testid={`tasks-toolbar-status-${chip.value}`}
              aria-pressed={active}
              className={cn(
                "h-6 px-2.5 rounded-full text-[11.5px] tracking-tight border",
                "transition-colors duration-[180ms] ease-out",
                active
                  ? "border-[var(--accent)] bg-[var(--bg-subtle)] text-[color:var(--text-primary)]"
                  : "border-[var(--border-subtle)] text-[color:var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[color:var(--text-primary)]",
              )}
            >
              {chip.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
