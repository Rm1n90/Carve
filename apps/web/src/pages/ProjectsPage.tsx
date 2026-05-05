// Armin Mehri — mehri.armin@gmail.com
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Link } from "@tanstack/react-router";
import {
  AlertTriangle,
  Bell,
  Calendar,
  FolderPlus,
  Plus,
  Search,
} from "lucide-react";
import { projectsApi, type Project } from "@/api/projects";
import { tasksApi, type Task } from "@/api/tasks";
import { ProjectCard } from "@/components/projects/ProjectCard";
import {
  ProjectsToolbar,
  type ProjectFilter,
  type ProjectSort,
  type ProjectView,
} from "@/components/projects/ProjectsToolbar";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
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
    } else if (filter === "recent") {
      const recentSet = new Set(recentIds);
      const orderIndex = new Map(recentIds.map((id, i) => [id, i] as const));
      return result
        .filter((p) => recentSet.has(p.id))
        .sort(
          (a, b) =>
            (orderIndex.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
            (orderIndex.get(b.id) ?? Number.MAX_SAFE_INTEGER),
        );
    }

    const next = [...result];
    next.sort((a, b) => compareProjects(sort, a, b));
    return next;
  }, [projects, debouncedQuery, filter, sort, pinnedSet, currentUser?.id, recentIds]);


  // Plan-15 Phase 9 follow-up — page-level stats for the hero strip.
  const ownedCount = currentUser?.id
    ? projects.filter((p) => p.owner_id === currentUser.id).length
    : 0;
  const sharedCount = currentUser?.id
    ? projects.filter((p) => p.owner_id !== currentUser.id).length
    : 0;
  const pinnedCount = projects.filter((p) => pinnedSet.has(p.id)).length;

  return (
    <div className="mx-auto grid max-w-[1100px] gap-5">
      {/* ---- Hero header ---- */}
      <header
        data-testid="projects-hero"
        className={cn(
          "relative overflow-hidden",
          "rounded-[var(--radius-lg)] border border-[var(--border-subtle)]",
          "bg-[var(--bg-elev)] px-6 py-7",
        )}
      >
        {/* Atmospheric background — radial wash + subtle grid. */}
        <div
          aria-hidden
          className="absolute inset-0 pointer-events-none"
          style={{
            backgroundImage:
              "radial-gradient(circle at 12% 0%, color-mix(in oklch, var(--accent) 22%, transparent), transparent 55%), radial-gradient(circle at 88% 100%, color-mix(in oklch, var(--accent) 12%, transparent), transparent 60%)",
          }}
        />
        <div
          aria-hidden
          className="absolute inset-0 pointer-events-none opacity-[0.05]"
          style={{
            backgroundImage:
              "linear-gradient(var(--text-primary) 1px, transparent 1px), linear-gradient(90deg, var(--text-primary) 1px, transparent 1px)",
            backgroundSize: "32px 32px",
            maskImage:
              "linear-gradient(to bottom, black, transparent 80%)",
          }}
        />
        <div className="relative flex items-end justify-between gap-4 flex-wrap">
          <div className="grid gap-1.5">
            <span className="font-mono text-[10px] tracking-[0.22em] uppercase text-[color:var(--text-tertiary)]">
              Workspace · Projects
            </span>
            <h1 className="font-editorial text-[44px] leading-[0.95] text-[color:var(--text-primary)]">
              Your Projects
            </h1>
            <p className="text-[13px] text-[color:var(--text-secondary)] max-w-prose mt-1">
              Annotation workspaces for images and video. Pin the ones you
              live in, archive the ones you don't.
            </p>
            <div className="flex items-center gap-3 mt-3 text-[11.5px] font-mono tabular-nums text-[color:var(--text-tertiary)]">
              <span>
                <span className="text-[color:var(--text-primary)] font-medium">
                  {projects.length}
                </span>{" "}
                total
              </span>
              <span aria-hidden>·</span>
              <span>
                <span className="text-[color:var(--text-primary)] font-medium">
                  {ownedCount}
                </span>{" "}
                owned
              </span>
              <span aria-hidden>·</span>
              <span>
                <span className="text-[color:var(--text-primary)] font-medium">
                  {sharedCount}
                </span>{" "}
                shared
              </span>
              {pinnedCount > 0 && (
                <>
                  <span aria-hidden>·</span>
                  <span>
                    <span className="text-[color:var(--accent)] font-medium">
                      {pinnedCount}
                    </span>{" "}
                    pinned
                  </span>
                </>
              )}
            </div>
          </div>
          <Button
            variant={showForm ? "secondary" : "primary"}
            size="md"
            leftIcon={<Plus className="h-4 w-4" />}
            onClick={() => setShowForm((s) => !s)}
          >
            {showForm ? "Cancel" : "New project"}
          </Button>
        </div>
      </header>

      {/* ---- Workspace deadlines — notification card across all projects ---- */}
      <WorkspaceDeadlines projects={projects} />

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
        <div className="grid gap-2" data-testid="projects-loading-skeleton">
          {[0, 1, 2, 3].map((i) => (
            <div
              key={i}
              className={cn(
                "h-[56px] rounded-[var(--radius-md)]",
                "border border-[var(--border-subtle)]",
                "bg-[var(--bg-subtle)] animate-pulse",
              )}
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
        <EmptyState
          testId="projects-empty"
          icon={<FolderPlus className="h-6 w-6" />}
          title="Start your first project"
          description="Carve datasets and annotation workspaces. Each project owns its classes, tasks, and assets — pick a name and start uploading."
          cta={{ label: "Create project", onClick: () => setShowForm(true) }}
        />
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

          {/* Plan 15 Track E — Recent moved into the toolbar tabs. */}

          {filtered.length === 0 ? (
            <EmptyState
              testId="projects-empty-search"
              variant="compact"
              icon={<Search className="h-5 w-5" />}
              title={debouncedQuery ? "No matches" : "No projects in view"}
              description={
                debouncedQuery
                  ? `No projects match "${debouncedQuery}".`
                  : "No projects match the current filter."
              }
              cta={
                debouncedQuery
                  ? { label: "Clear search", onClick: () => setQuery("") }
                  : undefined
              }
            />
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

// ---------------------------------------------------------------------------
// Plan-16 — Workspace-wide deadlines notification card. Surfaces every
// upcoming/overdue task across all projects so the user sees expiring work
// from the very first page. Severity is colour-coded: overdue/today red,
// ≤3 days orange, ≤7 days yellow.
// ---------------------------------------------------------------------------
type WorkspaceDueSeverity = "overdue" | "today" | "soon" | "watch" | "ok";

function workspaceDueSeverity(deltaMs: number): WorkspaceDueSeverity {
  const DAY = 24 * 60 * 60 * 1000;
  if (deltaMs < 0) return "overdue";
  if (deltaMs < DAY) return "today";
  if (deltaMs <= 3 * DAY) return "soon";
  if (deltaMs <= 7 * DAY) return "watch";
  return "ok";
}

function workspaceSeverityClasses(s: WorkspaceDueSeverity): {
  row: string;
  pill: string;
  icon: string;
} {
  switch (s) {
    case "overdue":
      return {
        row: "bg-[color-mix(in_oklch,var(--danger)_14%,transparent)] hover:bg-[color-mix(in_oklch,var(--danger)_22%,transparent)] text-[color:var(--danger)]",
        pill: "bg-[var(--danger)] text-white",
        icon: "text-[color:var(--danger)]",
      };
    case "today":
      return {
        row: "bg-[color-mix(in_oklch,var(--danger)_8%,transparent)] hover:bg-[color-mix(in_oklch,var(--danger)_14%,transparent)] text-[color:var(--danger)]",
        pill: "bg-[var(--danger)] text-white",
        icon: "text-[color:var(--danger)]",
      };
    case "soon":
      // DESIGN.md §2 — Warning Amber resolves to --warning so both
      // themes pull from the declared palette instead of hardcoded
      // #F59E0B.
      return {
        row: "bg-[color-mix(in_oklch,var(--warning)_10%,transparent)] hover:bg-[color-mix(in_oklch,var(--warning)_18%,transparent)] text-[color:var(--text-primary)]",
        pill: "bg-[var(--warning)] text-black",
        icon: "text-[color:var(--warning)]",
      };
    case "watch":
      // Less urgent than "soon" — same warning hue at 70% mix so it
      // reads as a quieter cousin without introducing a second amber.
      return {
        row: "hover:bg-[var(--bg-hover)] text-[color:var(--text-primary)]",
        pill: "bg-[color-mix(in_oklch,var(--warning)_70%,transparent)] text-black",
        icon: "text-[color:var(--warning)]",
      };
    default:
      return {
        row: "hover:bg-[var(--bg-hover)] text-[color:var(--text-primary)]",
        pill: "bg-[var(--bg-subtle)] text-[color:var(--text-secondary)]",
        icon: "text-[color:var(--text-tertiary)]",
      };
  }
}

interface WorkspaceDeadlineEntry {
  task: Task;
  projectId: string;
  projectName: string;
  deltaMs: number;
}

function WorkspaceDeadlines({ projects }: { projects: Project[] }) {
  // Fetch tasks per project in parallel. We cap the project fan-out at 24
  // to keep the request volume sane on huge workspaces; the user can
  // still drill into a project to see its tasks.
  const targets = projects.slice(0, 24);
  const queries = useQueries({
    queries: targets.map((p) => ({
      queryKey: ["tasks", p.id, "with-archived"] as const,
      queryFn: () => tasksApi.listForProject(p.id, { includeArchived: true }),
      staleTime: 60_000,
    })),
  });

  const now = Date.now();
  const DAY = 24 * 60 * 60 * 1000;
  const entries: WorkspaceDeadlineEntry[] = [];
  queries.forEach((q, i) => {
    const project = targets[i];
    if (!q.data || !project) return;
    for (const t of q.data) {
      if (!t.due_date || t.archived_at != null) continue;
      const due = Date.parse(t.due_date);
      if (!Number.isFinite(due)) continue;
      entries.push({
        task: t,
        projectId: project.id,
        projectName: project.name,
        deltaMs: due - now,
      });
    }
  });
  entries.sort((a, b) => a.deltaMs - b.deltaMs);
  const top = entries.slice(0, 6);

  if (top.length === 0) return null;

  const overdueCount = top.filter((e) => e.deltaMs < 0).length;

  return (
    <section
      data-testid="workspace-deadlines"
      aria-label="Upcoming task deadlines across all projects"
      className={cn(
        "rounded-[var(--radius-md)] border p-3 transition-colors",
        overdueCount > 0
          ? "border-[var(--danger)] bg-[color-mix(in_oklch,var(--danger)_6%,var(--bg-elev))]"
          : "border-[var(--border-subtle)] bg-[var(--bg-elev)]",
      )}
    >
      <header className="flex items-center justify-between mb-2">
        <h3 className="text-[12px] font-medium tracking-tight text-[color:var(--text-primary)] inline-flex items-center gap-1.5">
          {overdueCount > 0 ? (
            <AlertTriangle className="h-3.5 w-3.5 text-[color:var(--danger)] animate-pulse" />
          ) : (
            <Bell className="h-3.5 w-3.5 text-[color:var(--text-tertiary)]" />
          )}
          Deadlines
          {overdueCount > 0 && (
            <span
              data-testid="workspace-deadlines-overdue-badge"
              className="ml-1 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1.5 rounded-full bg-[var(--danger)] text-white font-mono text-[10px] tabular-nums font-semibold"
            >
              {overdueCount}
            </span>
          )}
        </h3>
        <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-[color:var(--text-tertiary)]">
          {entries.length > top.length
            ? `${top.length} of ${entries.length}`
            : `Next ${top.length}`}
        </span>
      </header>
      <ul className="grid gap-0.5">
        {top.map(({ task, projectId, projectName, deltaMs }) => {
          const sev = workspaceDueSeverity(deltaMs);
          const cls = workspaceSeverityClasses(sev);
          const days = Math.round(deltaMs / DAY);
          const label =
            sev === "overdue"
              ? `${Math.abs(days)}d overdue`
              : sev === "today"
                ? "due today"
                : days === 1
                  ? "due tomorrow"
                  : `due in ${days}d`;
          const Icon =
            sev === "overdue" || sev === "today" ? AlertTriangle : Calendar;
          return (
            <li key={`${projectId}-${task.id}`}>
              <Link
                to="/projects/$projectId/tasks/$taskId"
                params={{ projectId, taskId: task.id }}
                data-testid={`workspace-deadline-row-${task.id}`}
                data-severity={sev}
                className={cn(
                  "flex items-center gap-2 px-2 py-1.5 rounded-[var(--radius-xs)]",
                  "text-[12.5px] transition-colors",
                  cls.row,
                )}
              >
                <Icon className={cn("h-3.5 w-3.5 shrink-0", cls.icon)} />
                <span
                  className={cn(
                    "flex-1 min-w-0 truncate",
                    sev === "overdue" || sev === "today" ? "font-medium" : "",
                  )}
                >
                  {task.name}
                  <span className="ml-2 font-mono text-[10px] text-[color:var(--text-tertiary)]">
                    {projectName}
                  </span>
                </span>
                <span
                  className={cn(
                    "font-mono text-[10px] tabular-nums uppercase tracking-[0.06em] px-1.5 py-0.5 rounded-full font-semibold",
                    cls.pill,
                  )}
                >
                  {label}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
