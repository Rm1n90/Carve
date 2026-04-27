import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ChevronRight, Image as ImageIcon, Video } from "lucide-react";
import { projectsApi } from "@/api/projects";
import { tasksApi } from "@/api/tasks";
import { statsApi, type ProjectStats } from "@/api/stats";
import { Badge } from "@/components/ui/Badge";
import { ClassesEditor } from "./ClassesEditor";
import { NewTaskDialog } from "./NewTaskDialog";
import { cn } from "@/lib/cn";

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
      <section className="rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-elev)] p-4 text-[color:var(--text-tertiary)] text-[13px]">
        No data yet.
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
        <StatTile label="Assets" value={totals.assets} testId="project-stats-totals-assets" />
        <StatTile label="Tasks" value={totals.tasks} testId="project-stats-totals-tasks" />
      </div>

      {by_class.length > 0 && <span data-testid="project-stats-by-class" hidden aria-hidden />}

      {tasks.length > 0 && (
        <ul className="grid gap-1.5">
          {tasks.map((t) => {
            const pct = Math.round(Math.min(Math.max(t.progress_pct, 0), 1) * 100);
            const widthPct = `${pct}%`;
            return (
              <li
                key={t.task_id}
                className="grid grid-cols-[1fr_60px] items-center gap-3 text-[12.5px]"
              >
                <div className="flex items-center gap-3">
                  <span className="min-w-[80px] text-[color:var(--text-secondary)] tracking-tight truncate">
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

  // Browser tab title — show the current project name. See audit bug R.
  useEffect(() => {
    const name = projectQ.data?.name;
    if (!name) return;
    const previous = document.title;
    document.title = `${name} — Carve`;
    return () => {
      document.title = previous;
    };
  }, [projectQ.data?.name]);

  if (projectQ.isLoading) return <p className="text-[color:var(--text-tertiary)] text-[13px]">Loading…</p>;
  if (projectQ.error || !projectQ.data)
    return <p className="text-[color:var(--danger)] text-[13px]">Project not found.</p>;
  const project = projectQ.data;
  const topClasses = statsQ.data?.by_class.slice(0, 5) ?? [];

  return (
    <div className="mx-auto grid max-w-[1100px] gap-5">
      {/* ---- Header ---- */}
      <header className="flex items-baseline justify-between gap-4 flex-wrap">
        <div className="grid gap-0.5">
          <h1 className="text-[20px] font-medium tracking-tight text-[color:var(--text-primary)]">
            {project.name}
          </h1>
          {project.description && (
            <p className="text-[12.5px] text-[color:var(--text-tertiary)]">{project.description}</p>
          )}
        </div>
        {topClasses.length > 0 && (
          <div className="flex flex-wrap gap-1.5 max-w-[420px] justify-end">
            {topClasses.map((c) => (
              <Badge key={c.class_id} variant="ghost">
                {c.name}
                <span className="font-mono text-[10px] text-[color:var(--text-tertiary)]">{c.count}</span>
              </Badge>
            ))}
          </div>
        )}
      </header>

      {/* ---- Stats strip ---- */}
      {statsQ.isLoading && <p className="text-[color:var(--text-tertiary)] text-[13px]">Loading stats…</p>}
      {statsQ.data && <ProjectStatsStrip stats={statsQ.data} />}
      {statsQ.error && !statsQ.isLoading && (
        <section className="rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-elev)] p-4 text-[color:var(--text-tertiary)] text-[13px]">
          No data yet.
        </section>
      )}

      {/* ---- Two-column layout ---- */}
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
          {tasksQ.isLoading && <p className="text-[color:var(--text-tertiary)] text-[13px]">Loading tasks…</p>}
          <ul className="rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-elev)] overflow-hidden">
            {tasksQ.data?.map((t) => (
              <li key={t.id} className="border-b border-[var(--border-subtle)] last:border-b-0">
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
    </div>
  );
}
