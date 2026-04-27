import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import * as Tabs from "@radix-ui/react-tabs";
import {
  BarChart3,
  ChevronRight,
  Image as ImageIcon,
  Settings,
  Sparkles,
  Video,
} from "lucide-react";
import { projectsApi } from "@/api/projects";
import { tasksApi } from "@/api/tasks";
import { statsApi, type ProjectStats } from "@/api/stats";
import { Badge } from "@/components/ui/Badge";
import { ClassesEditor } from "./ClassesEditor";
import { NewTaskDialog } from "./NewTaskDialog";
import { StatsPanel } from "./StatsPanel";
import { cn } from "@/lib/cn";

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
        "grid gap-1 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-elev)]",
        "px-4 py-3 min-w-[120px]",
      )}
    >
      <span className="font-mono text-[22px] leading-none text-[color:var(--text-primary)] tracking-tight tabular-nums">
        {value}
      </span>
      <span className="text-[11px] uppercase tracking-[0.06em] text-[color:var(--text-tertiary)] font-medium">
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
        className="flex items-center gap-3 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-elev)] p-4"
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
          className="flex flex-wrap gap-1.5"
        >
          {by_class.slice(0, 8).map((c) => (
            <li key={c.class_id}>
              <Badge variant="ghost">
                <span className="truncate max-w-[140px]">{c.name}</span>
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
        <div className="grid gap-0.5">
          <h1 className="text-[20px] font-medium tracking-tight text-[color:var(--text-primary)]">
            {project.name}
          </h1>
          {project.description && (
            <p className="text-[12.5px] text-[color:var(--text-tertiary)]">
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

          {/* Two-column layout */}
          <div className="grid gap-5 grid-cols-1 lg:grid-cols-[2fr_1fr]">
            <section className="grid gap-3">
              <header className="flex items-center justify-between">
                <h2 className="text-[14px] font-medium tracking-tight text-[color:var(--text-primary)]">
                  Tasks
                </h2>
                <span className="font-mono text-[10.5px] text-[color:var(--text-tertiary)]">
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
                    className="border-b border-[var(--border-subtle)] last:border-b-0"
                  >
                    <Link
                      to="/projects/$projectId/tasks/$taskId"
                      params={{ projectId, taskId: t.id }}
                      className="flex items-center gap-3 px-4 py-2.5 hover:bg-[var(--bg-hover)] transition-colors group"
                    >
                      <span className="grid h-7 w-7 place-items-center rounded-[var(--radius-sm)] bg-[var(--bg-subtle)] text-[color:var(--text-secondary)]">
                        {t.kind === "video" ? (
                          <Video className="h-3.5 w-3.5" />
                        ) : (
                          <ImageIcon className="h-3.5 w-3.5" />
                        )}
                      </span>
                      <span className="flex-1 text-[13px] tracking-tight text-[color:var(--text-primary)] truncate">
                        {t.name}
                      </span>
                      <Badge variant="ghost">{t.kind}</Badge>
                      <ChevronRight className="h-3.5 w-3.5 text-[color:var(--text-tertiary)] transition-transform group-hover:translate-x-0.5" />
                    </Link>
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
