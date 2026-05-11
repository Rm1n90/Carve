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
        "rounded-[var(--radius-md)] border border-[var(--border-subtle)]",
        "bg-[var(--bg-elev)]/95 backdrop-blur-md",
        "p-2",
      )}
    >
      {/* Single-row toolbar — filter segmented control on the left,
          search in the middle, sort + view on the right. Wraps on
          narrow viewports but collapses to one row on desktop. */}
      <div className="flex flex-wrap items-center gap-2">
        <div
          role="tablist"
          aria-label="Filter projects"
          className={cn(
            "inline-flex h-8 p-0.5 rounded-[var(--radius-sm)]",
            "bg-[var(--bg-subtle)] border border-[var(--border-subtle)]",
          )}
        >
          {FILTER_CHIPS.map((chip) => {
            const active = chip.value === filter;
            return (
              <button
                key={chip.value}
                type="button"
                role="tab"
                onClick={() => onFilterChange(chip.value)}
                data-testid={`projects-toolbar-filter-${chip.value}`}
                aria-pressed={active}
                aria-selected={active}
                className={cn(
                  "h-7 px-2.5 rounded-[var(--radius-xs)]",
                  "text-[11.5px] tracking-tight font-medium",
                  "transition-colors duration-[160ms] ease-out",
                  active
                    ? "bg-[var(--bg-elev)] text-[color:var(--text-primary)] shadow-[0_1px_2px_rgba(0,0,0,0.06)]"
                    : "text-[color:var(--text-tertiary)] hover:text-[color:var(--text-primary)]",
                )}
              >
                {chip.label}
              </button>
            );
          })}
        </div>

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

        <div
          role="group"
          aria-label="View mode"
          className={cn(
            "inline-flex h-8 p-0.5 rounded-[var(--radius-sm)]",
            "bg-[var(--bg-subtle)] border border-[var(--border-subtle)]",
          )}
        >
          <button
            type="button"
            onClick={() => onViewChange("cards")}
            data-testid="projects-toolbar-view-cards"
            aria-pressed={view === "cards"}
            aria-label="Cards view"
            className={cn(
              "grid w-7 h-7 place-items-center rounded-[var(--radius-xs)]",
              "transition-colors duration-[160ms] ease-out",
              view === "cards"
                ? "bg-[var(--bg-elev)] text-[color:var(--text-primary)] shadow-[0_1px_2px_rgba(0,0,0,0.06)]"
                : "text-[color:var(--text-tertiary)] hover:text-[color:var(--text-primary)]",
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
              "grid w-7 h-7 place-items-center rounded-[var(--radius-xs)]",
              "transition-colors duration-[160ms] ease-out",
              view === "compact"
                ? "bg-[var(--bg-elev)] text-[color:var(--text-primary)] shadow-[0_1px_2px_rgba(0,0,0,0.06)]"
                : "text-[color:var(--text-tertiary)] hover:text-[color:var(--text-primary)]",
            )}
          >
            <List className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}
