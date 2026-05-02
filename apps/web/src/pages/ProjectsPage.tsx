import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Plus, FolderPlus } from "lucide-react";
import { projectsApi, type Project } from "@/api/projects";
import { ProjectCard } from "@/components/projects/ProjectCard";
import {
  ProjectsToolbar,
  type ProjectFilter,
  type ProjectSort,
  type ProjectView,
} from "@/components/projects/ProjectsToolbar";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { useAuth } from "@/auth/store";
import { useProjectPrefs } from "@/state/projectPrefs";
import { cn } from "@/lib/cn";

const VIRTUALISE_THRESHOLD = 40;
const ROW_HEIGHT_CARDS = 84;
const ROW_HEIGHT_COMPACT = 56;
const SEARCH_DEBOUNCE_MS = 200;

function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs]);
  return debounced;
}

function compareProjects(sort: ProjectSort, a: Project, b: Project): number {
  switch (sort) {
    case "name-asc":
      return a.name.localeCompare(b.name);
    case "name-desc":
      return b.name.localeCompare(a.name);
    case "updated-desc":
    case "created-desc":
      // No ``updated_at`` field is exposed yet, so both updated/created
      // currently sort by ``created_at`` (newest first). When the API
      // grows an ``updated_at`` column this branch will switch over.
      return (
        new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
      );
  }
}

export function ProjectsPage() {
  const qc = useQueryClient();
  const projectsQ = useQuery({
    queryKey: ["projects"],
    queryFn: projectsApi.list,
  });
  const createM = useMutation({
    mutationFn: projectsApi.create,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["projects"] }),
  });
  const deleteM = useMutation({
    mutationFn: projectsApi.delete,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["projects"] }),
  });

  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");

  // Toolbar state lives at the page level so the recent strip + virtual
  // grid can react to the same values.
  const [query, setQuery] = useState("");
  const debouncedQuery = useDebouncedValue(query, SEARCH_DEBOUNCE_MS);
  const [sort, setSort] = useState<ProjectSort>("name-asc");
  const [filter, setFilter] = useState<ProjectFilter>("all");
  const [view, setView] = useState<ProjectView>("cards");

  const currentUser = useAuth((s) => s.user);
  const pinnedIds = useProjectPrefs((s) => s.pinnedProjectIds);
  const recentIds = useProjectPrefs((s) => s.recentProjectIds);
  const togglePin = useProjectPrefs((s) => s.togglePin);
  const pinnedSet = useMemo(() => new Set(pinnedIds), [pinnedIds]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    await createM.mutateAsync({ name, description: description || undefined });
    setShowForm(false);
    setName("");
    setDescription("");
  }

  const projects = projectsQ.data ?? [];

  const filtered = useMemo(() => {
    const q = debouncedQuery.trim().toLowerCase();
    let result = projects;

    if (q) {
      result = result.filter((p) => {
        const nameHit = p.name.toLowerCase().includes(q);
        const ownerHit = (p.owner_email ?? "").toLowerCase().includes(q);
        return nameHit || ownerHit;
      });
    }

    if (filter === "pinned") {
      result = result.filter((p) => pinnedSet.has(p.id));
    } else if (filter === "owned") {
      result = result.filter(
        (p) => currentUser?.id != null && p.owner_id === currentUser.id,
      );
    } else if (filter === "shared") {
      result = result.filter(
        (p) => currentUser?.id != null && p.owner_id !== currentUser.id,
      );
    }

    const next = [...result];
    next.sort((a, b) => compareProjects(sort, a, b));
    return next;
  }, [projects, debouncedQuery, filter, sort, pinnedSet, currentUser?.id]);

  const isSearchingOrFiltering =
    debouncedQuery.trim() !== "" || filter !== "all";

  const recentProjects = useMemo(() => {
    if (isSearchingOrFiltering) return [];
    const byId = new Map(projects.map((p) => [p.id, p]));
    return recentIds
      .map((id) => byId.get(id))
      .filter((p): p is Project => p !== undefined)
      .slice(0, 5);
  }, [recentIds, projects, isSearchingOrFiltering]);

  return (
    <div className="mx-auto grid max-w-[1100px] gap-5">
      {/* ---- Header ---- */}
      <header className="flex items-baseline justify-between gap-4 flex-wrap">
        <div className="grid gap-1">
          <span className="font-mono text-[10px] tracking-[0.18em] uppercase text-[color:var(--text-tertiary)]">
            Workspace
          </span>
          <h1 className="font-editorial text-[36px] leading-[0.95] text-[color:var(--text-primary)]">
            Projects
          </h1>
          <p className="text-[12.5px] text-[color:var(--text-tertiary)] mt-0.5">
            Carve datasets and annotation workspaces.
          </p>
        </div>
        <Button
          variant={showForm ? "secondary" : "primary"}
          size="md"
          leftIcon={<Plus className="h-4 w-4" />}
          onClick={() => setShowForm((s) => !s)}
        >
          {showForm ? "Cancel" : "New project"}
        </Button>
      </header>

      {/* ---- Inline create form ---- */}
      {showForm && (
        <form
          onSubmit={onSubmit}
          className={cn(
            "grid gap-3 sm:grid-cols-[1fr_2fr_auto] items-end",
            "rounded-[var(--radius-md)] border border-[var(--border-subtle)]",
            "bg-[var(--bg-elev)] p-4",
          )}
        >
          <Input
            label="Name"
            required
            minLength={1}
            maxLength={120}
            placeholder="Carve project name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <Input
            label="Description"
            maxLength={4000}
            placeholder="What's this project about?"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
          <Button type="submit" variant="primary" loading={createM.isPending}>
            {createM.isPending ? "Creating" : "Create"}
          </Button>
        </form>
      )}

      {/* ---- States ---- */}
      {projectsQ.isLoading && (
        <div className="grid gap-2">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="h-[56px] rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-subtle)] animate-pulse"
            />
          ))}
        </div>
      )}
      {projectsQ.error && (
        <p className="text-[color:var(--danger)] text-[13px]">
          Failed to load projects.
        </p>
      )}

      {!projectsQ.isLoading && projects.length === 0 && (
        <div
          className={cn(
            "grid place-items-center gap-2 px-6 py-14",
            "rounded-[var(--radius-lg)] border border-dashed border-[var(--border-strong)]",
            "bg-[var(--bg-subtle)]",
          )}
        >
          <FolderPlus
            className="h-6 w-6 text-[color:var(--text-tertiary)]"
            aria-hidden
          />
          <span className="text-[14px] font-medium text-[color:var(--text-primary)]">
            No projects yet
          </span>
          <span className="text-[12.5px] text-[color:var(--text-tertiary)]">
            Create your first one.
          </span>
          <div className="mt-1">
            <Button
              variant="primary"
              size="md"
              leftIcon={<Plus className="h-4 w-4" />}
              onClick={() => setShowForm(true)}
            >
              New project
            </Button>
          </div>
        </div>
      )}

      {projects.length > 0 && (
        <>
          <ProjectsToolbar
            query={query}
            onQueryChange={setQuery}
            sort={sort}
            onSortChange={setSort}
            filter={filter}
            onFilterChange={setFilter}
            view={view}
            onViewChange={setView}
          />

          {recentProjects.length > 0 && (
            <section data-testid="projects-recent" className="grid gap-2">
              <h2 className="font-mono text-[10px] tracking-[0.18em] uppercase text-[color:var(--text-tertiary)]">
                Recent
              </h2>
              <div className="rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-elev)] overflow-hidden">
                {recentProjects.map((p) => (
                  <ProjectCard
                    key={`recent-${p.id}`}
                    project={p}
                    pinned={pinnedSet.has(p.id)}
                    onTogglePin={() => togglePin(p.id)}
                    onDelete={() => deleteM.mutate(p.id)}
                    view="compact"
                  />
                ))}
              </div>
            </section>
          )}

          {filtered.length === 0 ? (
            <div
              data-testid="projects-empty-search"
              className={cn(
                "grid place-items-center gap-2 px-6 py-10",
                "rounded-[var(--radius-md)] border border-dashed border-[var(--border-subtle)]",
                "bg-[var(--bg-subtle)]",
              )}
            >
              <span className="text-[12.5px] text-[color:var(--text-tertiary)]">
                {debouncedQuery
                  ? `No matches for "${debouncedQuery}".`
                  : "No projects match the current filter."}
              </span>
            </div>
          ) : (
            <ProjectsList
              projects={filtered}
              pinnedSet={pinnedSet}
              onTogglePin={togglePin}
              onDelete={(id) => deleteM.mutate(id)}
              view={view}
            />
          )}
        </>
      )}
    </div>
  );
}

interface ProjectsListProps {
  projects: Project[];
  pinnedSet: Set<string>;
  onTogglePin: (id: string) => void;
  onDelete: (id: string) => void;
  view: ProjectView;
}

/**
 * Switches between a plain mapped list (when ``projects.length`` is below
 * ``VIRTUALISE_THRESHOLD``) and a virtualised list backed by
 * ``@tanstack/react-virtual``. The virtualiser is constrained to a
 * scrollable region so the page itself doesn't grow unbounded.
 */
function ProjectsList({
  projects,
  pinnedSet,
  onTogglePin,
  onDelete,
  view,
}: ProjectsListProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const rowHeight = view === "cards" ? ROW_HEIGHT_CARDS : ROW_HEIGHT_COMPACT;

  const virtualizer = useVirtualizer({
    count: projects.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: 6,
  });

  if (projects.length < VIRTUALISE_THRESHOLD) {
    return (
      <section
        data-testid="projects-list"
        data-virtualised="false"
        className={cn(
          "rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-elev)] overflow-hidden",
        )}
      >
        {projects.map((p) => (
          <ProjectCard
            key={p.id}
            project={p}
            pinned={pinnedSet.has(p.id)}
            onTogglePin={() => onTogglePin(p.id)}
            onDelete={() => onDelete(p.id)}
            view={view}
          />
        ))}
      </section>
    );
  }

  return (
    <section
      ref={scrollRef}
      data-testid="projects-list"
      data-virtualised="true"
      className={cn(
        "rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-elev)] overflow-y-auto",
        "max-h-[70vh]",
      )}
    >
      <div
        style={{
          height: `${virtualizer.getTotalSize()}px`,
          position: "relative",
          width: "100%",
        }}
      >
        {virtualizer.getVirtualItems().map((vi) => {
          const project = projects[vi.index];
          if (!project) return null;
          return (
            <div
              key={project.id}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                transform: `translateY(${vi.start}px)`,
              }}
            >
              <ProjectCard
                project={project}
                pinned={pinnedSet.has(project.id)}
                onTogglePin={() => onTogglePin(project.id)}
                onDelete={() => onDelete(project.id)}
                view={view}
              />
            </div>
          );
        })}
      </div>
    </section>
  );
}
