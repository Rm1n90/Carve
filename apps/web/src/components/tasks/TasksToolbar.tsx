// Armin Mehri — mehri.armin@gmail.com
import { Search, X, Plus } from "lucide-react";
import { cn } from "@/lib/cn";
import { Input, Select } from "@/components/ui";

/**
 * Plan 14 Phase 8 Task 2 — sticky toolbar for the project detail's
 * Tasks tab. Owns search, status, sort, and "New task" controls.
 */
// Plan-21 — `"completed"` chip joins the existing trio. ``"active"``
// keeps its prior meaning of "not archived" but also implicitly excludes
// completed tasks (the page filter handles that). ``"completed"`` is a
// dedicated tab so users can audit finished work.
export type TaskStatusFilter = "all" | "active" | "completed" | "archived";
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

// Plan-21 — chip order matches a natural workflow read: All → Active →
// Completed → Archived. The default selection on the page is "Active".
const STATUS_CHIPS: { value: TaskStatusFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "active", label: "Active" },
  { value: "completed", label: "Completed" },
  { value: "archived", label: "Archived" },
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
          <Input
            type="search"
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            placeholder="Search tasks…"
            data-testid="tasks-toolbar-search"
            aria-label="Search tasks"
            leftIcon={<Search className="h-3.5 w-3.5" aria-hidden />}
            className={query ? "pr-9" : undefined}
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

        <Select
          value={sort}
          onValueChange={(v) => onSortChange(v as TaskSort)}
        >
          <Select.Trigger
            aria-label="Sort tasks"
            data-testid="tasks-toolbar-sort"
          >
            <Select.Value />
          </Select.Trigger>
          <Select.Content>
            {SORT_OPTIONS.map((o) => (
              <Select.Item key={o.value} value={o.value}>
                {o.label}
              </Select.Item>
            ))}
          </Select.Content>
        </Select>

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
