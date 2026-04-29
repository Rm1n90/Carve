import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import * as Tabs from "@radix-ui/react-tabs";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  BarChart3,
  ChevronRight,
  Copy,
  CopyPlus,
  Image as ImageIcon,
  MoreVertical,
  Settings,
  Sparkles,
  Video,
} from "lucide-react";
import { projectsApi } from "@/api/projects";
import { tasksApi, type Task } from "@/api/tasks";
import { statsApi, type ProjectStats } from "@/api/stats";
import { Badge } from "@/components/ui/Badge";
import { ClassesEditor } from "./ClassesEditor";
import { NewTaskDialog } from "./NewTaskDialog";
import { StatsPanel } from "./StatsPanel";
import { cn } from "@/lib/cn";
import { showToast } from "@/lib/toast";

// ---------------------------------------------------------------------------
// Stat tile (used inside the totals strip)
// ---------------------------------------------------------------------------
function StatTile({
  label,
  value,
  testId,
}: {
  label: string;
  value: number;
  testId: string;
}) {
  return (
    <div
      data-testid={testId}
      className={cn(
        "relative grid gap-2 rounded-2xl",
        "glass-surface glass-specular",
        "px-5 py-4 min-w-[140px]",
      )}
    >
      <span className="relative z-10 font-mono text-[36px] leading-none text-[color:var(--text-primary)] font-semibold tabular-tight">
        {value}
      </span>
      <span className="relative z-10 font-mono text-[10px] tracking-[0.18em] uppercase text-[color:var(--text-tertiary)] font-medium">
        {label}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stats strip (totals + per-task progress + by_class chips). The previous
// implementation hid the by_class block behind `hidden aria-hidden`; that hack
// is gone — when there's data, we render real chips.
// ---------------------------------------------------------------------------
function ProjectStatsStrip({ stats }: { stats: ProjectStats }) {
  const { totals, by_class, tasks } = stats;
  const hasAny =
    totals.annotations > 0 ||
    totals.assets > 0 ||
    totals.tasks > 0 ||
    by_class.length > 0 ||
    tasks.length > 0;

  if (!hasAny) {
    return (
      <section
        data-testid="project-stats-empty"
        className="relative flex items-center gap-3 rounded-2xl glass-surface p-4"
      >
        <span className="grid h-8 w-8 place-items-center rounded-full bg-[var(--bg-subtle)] text-[color:var(--text-tertiary)]">
          <Sparkles className="h-4 w-4" />
        </span>
        <p className="text-[13px] text-[color:var(--text-secondary)]">
          No data yet — upload assets and start annotating to populate stats.
        </p>
      </section>
    );
  }

  return (
    <section className="grid gap-3">
      <div className="flex flex-wrap gap-2">
        <StatTile
          label="Annotations"
          value={totals.annotations}
          testId="project-stats-totals-annotations"
        />
        <StatTile
          label="Assets"
          value={totals.assets}
          testId="project-stats-totals-assets"
        />
        <StatTile
          label="Tasks"
          value={totals.tasks}
          testId="project-stats-totals-tasks"
        />
      </div>

      {by_class.length > 0 && (
        <ul
          data-testid="project-stats-by-class"
          className="flex flex-nowrap gap-1.5 overflow-x-auto scrollbar-thin"
        >
          {by_class.slice(0, 8).map((c) => (
            <li key={c.class_id} className="shrink-0">
              <Badge variant="ghost">
                <span className="truncate max-w-[120px]">{c.name}</span>
                <span className="font-mono text-[10px] tabular-nums text-[color:var(--text-tertiary)]">
                  {c.count}
                </span>
              </Badge>
            </li>
          ))}
        </ul>
      )}

      {tasks.length > 0 && (
        <ul className="grid gap-1.5">
          {tasks.map((t) => {
            const pct = Math.round(
              Math.min(Math.max(t.progress_pct, 0), 1) * 100,
            );
            const widthPct = `${pct}%`;
            return (
              <li
                key={t.task_id}
                className="grid grid-cols-[1fr_60px] items-center gap-3 text-[12.5px]"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <span
                    className="min-w-[80px] max-w-[200px] text-[color:var(--text-secondary)] tracking-tight truncate"
                    title={t.name}
                  >
                    {t.name}
                  </span>
                  <div className="relative h-1 flex-1 overflow-hidden rounded-full bg-[var(--bg-hover)]">
                    <div
                      data-testid={`project-stats-task-bar-${t.task_id}`}
                      className="absolute inset-y-0 left-0 bg-[var(--accent)]"
                      style={{ width: widthPct }}
                    />
                  </div>
                </div>
                <span className="text-right font-mono text-[10.5px] text-[color:var(--text-tertiary)] tabular-nums">
                  {widthPct}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Settings tab — basic edit form for project name/description.
// ---------------------------------------------------------------------------
function ProjectSettingsForm({
  projectId,
  initialName,
  initialDescription,
}: {
  projectId: string;
  initialName: string;
  initialDescription: string | null;
}) {
  const [name, setName] = useState(initialName);
  const [description, setDescription] = useState(initialDescription ?? "");
  const qc = useQueryClient();
  const m = useMutation({
    mutationFn: () =>
      projectsApi.update(projectId, {
        name,
        description: description.trim() || undefined,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["project", projectId] });
      qc.invalidateQueries({ queryKey: ["projects"] });
    },
  });

  const dirty =
    name !== initialName || description !== (initialDescription ?? "");

  return (
    <form
      data-testid="project-settings-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!dirty || !name.trim()) return;
        m.mutate();
      }}
      className="grid gap-4 max-w-[640px]"
    >
      <div className="grid gap-1.5">
        <label
          htmlFor="project-name"
          className="text-[12px] uppercase tracking-[0.08em] text-[color:var(--text-tertiary)]"
        >
          Name
        </label>
        <input
          id="project-name"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className={cn(
            "h-9 px-2.5 rounded-[var(--radius-sm)]",
            "bg-[var(--bg-sunken)] text-[color:var(--text-primary)]",
            "border border-[var(--border-subtle)] text-[13px]",
            "focus:outline-none focus:border-[var(--accent)]",
          )}
        />
      </div>

      <div className="grid gap-1.5">
        <label
          htmlFor="project-description"
          className="text-[12px] uppercase tracking-[0.08em] text-[color:var(--text-tertiary)]"
        >
          Description
        </label>
        <textarea
          id="project-description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={3}
          className={cn(
            "px-2.5 py-2 rounded-[var(--radius-sm)] resize-y",
            "bg-[var(--bg-sunken)] text-[color:var(--text-primary)]",
            "border border-[var(--border-subtle)] text-[13px]",
            "focus:outline-none focus:border-[var(--accent)]",
          )}
        />
      </div>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={!dirty || !name.trim() || m.isPending}
          className={cn(
            "h-8 px-3 rounded-[var(--radius-sm)] text-[12.5px] font-medium tracking-tight",
            "bg-[var(--accent)] text-[color:var(--accent-fg)]",
            "hover:bg-[var(--accent-hover)] disabled:opacity-50 disabled:cursor-not-allowed",
            "transition-colors",
          )}
        >
          {m.isPending ? "Saving…" : "Save changes"}
        </button>
        {m.isError && (
          <span className="text-[12px] text-[color:var(--danger)]">
            Save failed.
          </span>
        )}
        {m.isSuccess && !dirty && (
          <span className="text-[12px] text-[color:var(--success)]">Saved.</span>
        )}
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Per-task 3-dot menu — duplicate × 1 / × 3 (v3.0 Bug 8). Existing nav happens
// via the row's <Link>; the menu sits next to it as a sibling so click events
// don't propagate into the navigation.
// ---------------------------------------------------------------------------
function TaskRowMenu({
  task,
  pending,
  onDuplicate,
}: {
  task: Task;
  pending: boolean;
  onDuplicate: (count: number) => void;
}) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          data-testid={`project-detail-task-menu-trigger-${task.id}`}
          aria-label={`More actions for task ${task.name}`}
          disabled={pending}
          onClick={(e) => e.stopPropagation()}
          className={cn(
            "grid w-9 shrink-0 place-items-center",
            "text-[color:var(--text-tertiary)]",
            "hover:bg-[var(--bg-subtle)] hover:text-[color:var(--text-primary)]",
            "focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--accent)]",
            "disabled:opacity-50 disabled:cursor-not-allowed",
            "transition-colors",
          )}
        >
          <MoreVertical className="h-3.5 w-3.5" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={4}
          onClick={(e) => e.stopPropagation()}
          className="z-[1000] min-w-[180px] rounded-[var(--radius-md)] glass-surface-strong p-1"
        >
          <DropdownMenu.Item
            data-testid={`project-detail-task-duplicate-${task.id}`}
            onSelect={() => onDuplicate(1)}
            className={cn(
              "flex items-center gap-2 px-2 py-1.5 rounded-[var(--radius-xs)] text-[12.5px]",
              "cursor-pointer outline-none text-[color:var(--text-primary)]",
              "data-[highlighted]:bg-[var(--bg-hover)]",
            )}
          >
            <Copy className="h-3.5 w-3.5 text-[color:var(--text-tertiary)]" />
            <span className="flex-1">Duplicate</span>
          </DropdownMenu.Item>
          <DropdownMenu.Item
            data-testid={`project-detail-task-duplicate-x3-${task.id}`}
            onSelect={() => onDuplicate(3)}
            className={cn(
              "flex items-center gap-2 px-2 py-1.5 rounded-[var(--radius-xs)] text-[12.5px]",
              "cursor-pointer outline-none text-[color:var(--text-primary)]",
              "data-[highlighted]:bg-[var(--bg-hover)]",
            )}
          >
            <CopyPlus className="h-3.5 w-3.5 text-[color:var(--text-tertiary)]" />
            <span className="flex-1">Duplicate ×3</span>
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

// ---------------------------------------------------------------------------
// Tab trigger styling — same look as AnnotateAssetPage tabs.
// ---------------------------------------------------------------------------
const tabTriggerClass = cn(
  "px-3 py-1.5 text-[12.5px] tracking-tight rounded-t-[var(--radius-sm)]",
  "text-[color:var(--text-tertiary)] border-b-2 border-transparent",
  "hover:text-[color:var(--text-primary)]",
  "data-[state=active]:text-[color:var(--text-primary)]",
  "data-[state=active]:border-[var(--accent)]",
  "transition-colors flex items-center gap-1.5",
);

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------
export function ProjectDetailPage({ projectId }: { projectId: string }) {
  const projectQ = useQuery({
    queryKey: ["project", projectId],
    queryFn: () => projectsApi.get(projectId),
  });
  const tasksQ = useQuery({
    queryKey: ["tasks", projectId],
    queryFn: () => tasksApi.listForProject(projectId),
  });
  const statsQ = useQuery({
    queryKey: ["project-stats", projectId],
    queryFn: () => statsApi.projectStats(projectId),
  });
  const qc = useQueryClient();
  const duplicateTask = useMutation({
    mutationFn: ({ taskId, count }: { taskId: string; count: number }) =>
      tasksApi.duplicate(projectId, taskId, count),
    onSuccess: (created, vars) => {
      qc.invalidateQueries({ queryKey: ["tasks", projectId] });
      qc.invalidateQueries({ queryKey: ["project-stats", projectId] });
      showToast(
        vars.count === 1
          ? "Duplicated"
          : `${created.length} copies created`,
        { variant: "success" },
      );
    },
    onError: () => {
      showToast("Failed to duplicate task", { variant: "error" });
    },
  });

  // Browser tab title — show the current project name.
  useEffect(() => {
    const name = projectQ.data?.name;
    if (!name) return;
    const previous = document.title;
    document.title = `${name} — Carve`;
    return () => {
      document.title = previous;
    };
  }, [projectQ.data?.name]);

  if (projectQ.isLoading)
    return (
      <p className="text-[color:var(--text-tertiary)] text-[13px]">Loading…</p>
    );
  if (projectQ.error || !projectQ.data)
    return (
      <p className="text-[color:var(--danger)] text-[13px]">
        Project not found.
      </p>
    );
  const project = projectQ.data;

  return (
    <div className="mx-auto grid max-w-[1100px] gap-5">
      {/* ---- Header ---- */}
      <header className="flex items-baseline justify-between gap-4 flex-wrap">
        <div className="grid gap-1">
          <span className="font-mono text-[10px] tracking-[0.18em] uppercase text-[color:var(--text-tertiary)]">
            Project
          </span>
          <h1 className="font-editorial text-[36px] leading-[0.95] text-[color:var(--text-primary)]">
            {project.name}
          </h1>
          {project.description && (
            <p className="text-[12.5px] text-[color:var(--text-tertiary)] mt-0.5">
              {project.description}
            </p>
          )}
        </div>
        <Link
          to="/projects/$projectId/stats"
          params={{ projectId }}
          data-testid="project-detail-view-stats-link"
          className={cn(
            "inline-flex items-center gap-1.5 h-8 px-3",
            "rounded-[var(--radius-sm)] border border-[var(--border-subtle)]",
            "text-[12.5px] tracking-tight text-[color:var(--text-secondary)]",
            "hover:bg-[var(--bg-hover)] hover:text-[color:var(--text-primary)]",
            "transition-colors",
          )}
        >
          <BarChart3 className="h-3.5 w-3.5" />
          View stats
        </Link>
      </header>

      <Tabs.Root defaultValue="overview" data-testid="project-detail-tabs">
        <Tabs.List
          aria-label="Project sections"
          className="flex border-b border-[var(--border-subtle)] gap-1 mb-5"
        >
          <Tabs.Trigger
            value="overview"
            className={tabTriggerClass}
            data-testid="project-tab-overview"
          >
            <ImageIcon className="h-3.5 w-3.5" /> Overview
          </Tabs.Trigger>
          <Tabs.Trigger
            value="stats"
            className={tabTriggerClass}
            data-testid="project-tab-stats"
          >
            <BarChart3 className="h-3.5 w-3.5" /> Stats
          </Tabs.Trigger>
          <Tabs.Trigger
            value="settings"
            className={tabTriggerClass}
            data-testid="project-tab-settings"
          >
            <Settings className="h-3.5 w-3.5" /> Settings
          </Tabs.Trigger>
        </Tabs.List>

        {/* ---- Overview tab ---- */}
        <Tabs.Content
          value="overview"
          className="grid gap-5 focus-visible:outline-none"
          data-testid="project-tab-content-overview"
        >
          {/* Stats strip */}
          {statsQ.isLoading && (
            <p className="text-[color:var(--text-tertiary)] text-[13px]">
              Loading stats…
            </p>
          )}
          {statsQ.data && <ProjectStatsStrip stats={statsQ.data} />}
          {statsQ.error && !statsQ.isLoading && (
            <section className="rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-elev)] p-4 text-[color:var(--text-tertiary)] text-[13px]">
              No data yet.
            </section>
          )}

          {/* Two-column layout — items-start so each column takes its natural
              content height. v2.6 work on ClassesEditor (max-h on its inner
              shell) is preserved; we simply stop forcing the Tasks column to
              match the Classes column height. */}
          <div
            data-testid="project-detail-overview-grid"
            className="grid gap-5 items-start grid-cols-1 lg:grid-cols-[2fr_1fr]"
          >
            <section
              data-testid="project-detail-tasks-section"
              className="grid gap-3"
            >
              <header className="flex items-center gap-2">
                <h2 className="text-[14px] font-medium tracking-tight text-[color:var(--text-primary)]">
                  Tasks
                </h2>
                <span
                  data-testid="project-detail-tasks-total"
                  className="font-mono text-[10.5px] text-[color:var(--text-tertiary)]"
                >
                  {tasksQ.data?.length ?? 0} total
                </span>
              </header>
              <NewTaskDialog projectId={projectId} onCreated={() => {}} />
              {tasksQ.isLoading && (
                <p className="text-[color:var(--text-tertiary)] text-[13px]">
                  Loading tasks…
                </p>
              )}
              <ul className="rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-elev)] overflow-hidden">
                {tasksQ.data?.map((t) => (
                  <li
                    key={t.id}
                    className="flex items-stretch border-b border-[var(--border-subtle)] last:border-b-0 hover:bg-[var(--bg-hover)] transition-colors group"
                  >
                    <Link
                      to="/projects/$projectId/tasks/$taskId"
                      params={{ projectId, taskId: t.id }}
                      data-testid={`project-detail-task-row-${t.id}`}
                      className="flex flex-1 items-center gap-3 px-3 py-2 min-w-0"
                    >
                      <span className="grid h-6 w-6 place-items-center rounded-[var(--radius-sm)] bg-[var(--bg-subtle)] text-[color:var(--text-secondary)]">
                        {t.kind === "video" ? (
                          <Video className="h-3 w-3" />
                        ) : (
                          <ImageIcon className="h-3 w-3" />
                        )}
                      </span>
                      <span className="flex-1 text-[12.5px] tracking-tight text-[color:var(--text-primary)] truncate">
                        {t.name}
                      </span>
                      <Badge variant="ghost">{t.kind}</Badge>
                      <ChevronRight className="h-3.5 w-3.5 text-[color:var(--text-tertiary)] transition-transform group-hover:translate-x-0.5" />
                    </Link>
                    <TaskRowMenu
                      task={t}
                      pending={
                        duplicateTask.isPending &&
                        duplicateTask.variables?.taskId === t.id
                      }
                      onDuplicate={(count) =>
                        duplicateTask.mutate({ taskId: t.id, count })
                      }
                    />
                  </li>
                ))}
                {(tasksQ.data?.length ?? 0) === 0 && !tasksQ.isLoading && (
                  <li className="text-[color:var(--text-tertiary)] text-[13px] italic px-4 py-3">
                    No tasks yet.
                  </li>
                )}
              </ul>
            </section>
            <ClassesEditor projectId={projectId} />
          </div>
        </Tabs.Content>

        {/* ---- Stats tab ---- */}
        <Tabs.Content
          value="stats"
          className="focus-visible:outline-none"
          data-testid="project-tab-content-stats"
        >
          <StatsPanel projectId={projectId} />
        </Tabs.Content>

        {/* ---- Settings tab ---- */}
        <Tabs.Content
          value="settings"
          className="focus-visible:outline-none"
          data-testid="project-tab-content-settings"
        >
          <ProjectSettingsForm
            projectId={projectId}
            initialName={project.name}
            initialDescription={project.description}
          />
        </Tabs.Content>
      </Tabs.Root>
    </div>
  );
}
