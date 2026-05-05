// Armin Mehri — mehri.armin@gmail.com
import { Search, X, LayoutGrid, List } from "lucide-react";
import { cn } from "@/lib/cn";
import { Input, Select } from "@/components/ui";

/**
 * Plan 14 Phase 8 Task 1 — sticky toolbar for the projects index. Owns
 * search, sort, filter, and view-mode controls. State is held by the
 * parent (``ProjectsPage``) so the page can also drive the recent strip
 * + virtualisation thresholds from the same values.
 */
export type ProjectSort =
  | "name-asc"
  | "name-desc"
  | "updated-desc"
  | "created-desc";

export type ProjectFilter = "all" | "recent" | "owned" | "shared" | "pinned";

export type ProjectView = "cards" | "compact";

interface Props {
  query: string;
  onQueryChange: (q: string) => void;
  sort: ProjectSort;
  onSortChange: (s: ProjectSort) => void;
  filter: ProjectFilter;
  onFilterChange: (f: ProjectFilter) => void;
  view: ProjectView;
  onViewChange: (v: ProjectView) => void;
}

const FILTER_CHIPS: { value: ProjectFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "recent", label: "Recent" },
  { value: "owned", label: "Owned" },
  { value: "shared", label: "Shared" },
  { value: "pinned", label: "Pinned" },
];

const SORT_OPTIONS: { value: ProjectSort; label: string }[] = [
  { value: "name-asc", label: "Name (A-Z)" },
  { value: "name-desc", label: "Name (Z-A)" },
  { value: "updated-desc", label: "Updated (newest)" },
  { value: "created-desc", label: "Created (newest)" },
];

export function ProjectsToolbar({
  query,
  onQueryChange,
  sort,
  onSortChange,
  filter,
  onFilterChange,
  view,
  onViewChange,
}: Props) {
  return (
    <div
      data-testid="projects-toolbar"
      className={cn(
        "sticky top-0 z-20",
        "grid gap-2 py-2",
        "bg-[var(--bg-app)]/85 backdrop-blur-md",
        "border-b border-[var(--border-subtle)]",
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        {/* Search input */}
        <div className="relative min-w-[220px] flex-1">
          <Input
            type="search"
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            placeholder="Search projects by name or owner email…"
            data-testid="projects-toolbar-search"
            aria-label="Search projects"
            leftIcon={<Search className="h-3.5 w-3.5" aria-hidden />}
            className={query ? "pr-9" : undefined}
          />
          {query && (
            <button
              type="button"
              onClick={() => onQueryChange("")}
              data-testid="projects-toolbar-search-clear"
              aria-label="Clear search"
              className="absolute right-2 top-1/2 -translate-y-1/2 grid h-5 w-5 place-items-center rounded-[var(--radius-xs)] text-[color:var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[color:var(--text-primary)]"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>

        {/* Sort dropdown */}
        <Select
          value={sort}
          onValueChange={(v) => onSortChange(v as ProjectSort)}
        >
          <Select.Trigger
            aria-label="Sort projects"
            data-testid="projects-toolbar-sort"
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

        {/* View toggle */}
        <div
          role="group"
          aria-label="View mode"
          className="inline-flex h-8 rounded-[var(--radius-sm)] border border-[var(--border-subtle)] overflow-hidden"
        >
          <button
            type="button"
            onClick={() => onViewChange("cards")}
            data-testid="projects-toolbar-view-cards"
            aria-pressed={view === "cards"}
            aria-label="Cards view"
            className={cn(
              "grid w-8 place-items-center text-[color:var(--text-tertiary)]",
              view === "cards" &&
                "bg-[var(--bg-subtle)] text-[color:var(--text-primary)]",
              "hover:bg-[var(--bg-hover)] hover:text-[color:var(--text-primary)]",
            )}
          >
            <LayoutGrid className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => onViewChange("compact")}
            data-testid="projects-toolbar-view-compact"
            aria-pressed={view === "compact"}
            aria-label="Compact list view"
            className={cn(
              "grid w-8 place-items-center text-[color:var(--text-tertiary)] border-l border-[var(--border-subtle)]",
              view === "compact" &&
                "bg-[var(--bg-subtle)] text-[color:var(--text-primary)]",
              "hover:bg-[var(--bg-hover)] hover:text-[color:var(--text-primary)]",
            )}
          >
            <List className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Filter chips */}
      <div className="flex flex-wrap items-center gap-1.5">
        {FILTER_CHIPS.map((chip) => {
          const active = chip.value === filter;
          return (
            <button
              key={chip.value}
              type="button"
              onClick={() => onFilterChange(chip.value)}
              data-testid={`projects-toolbar-filter-${chip.value}`}
              aria-pressed={active}
              className={cn(
                "h-6 px-2.5 rounded-full text-[11.5px] tracking-tight",
                "border transition-colors duration-[180ms] ease-out",
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
