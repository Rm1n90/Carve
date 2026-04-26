import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { motion } from "framer-motion";
import { ChevronRight, Image as ImageIcon, Video } from "lucide-react";
import { projectsApi } from "@/api/projects";
import { tasksApi } from "@/api/tasks";
import { statsApi, type ProjectStats } from "@/api/stats";
import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { ClassesEditor } from "./ClassesEditor";
import { NewTaskDialog } from "./NewTaskDialog";

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
      className="grid gap-1 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-5 py-4 min-w-[140px]"
    >
      <span className="font-mono-data text-[32px] leading-none text-primary tracking-tight">
        {value}
      </span>
      <span className="text-[11px] uppercase tracking-[0.10em] text-tertiary font-medium">
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
      <section className="rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-5 text-tertiary text-[13px]">
        No data yet.
      </section>
    );
  }

  return (
    <section className="grid gap-4">
      <div className="flex flex-wrap gap-3">
        <StatTile
          label="Annotations"
          value={totals.annotations}
          testId="project-stats-totals-annotations"
        />
        <StatTile label="Assets" value={totals.assets} testId="project-stats-totals-assets" />
        <StatTile label="Tasks" value={totals.tasks} testId="project-stats-totals-tasks" />
      </div>

      {/* by_class chips are rendered in the page header above; this attribute keeps the
          test selector stable while not duplicating the visible badges. */}
      {by_class.length > 0 && (
        <span data-testid="project-stats-by-class" hidden aria-hidden />
      )}

      {tasks.length > 0 && (
        <ul className="grid gap-2">
          {tasks.map((t) => {
            const pct = Math.round(Math.min(Math.max(t.progress_pct, 0), 1) * 100);
            const widthPct = `${pct}%`;
            return (
              <li
                key={t.task_id}
                className="grid grid-cols-[1fr_80px] items-center gap-3 text-[13px]"
              >
                <div className="flex items-center gap-3">
                  <span className="min-w-[80px] text-secondary tracking-tight">{t.name}</span>
                  <div className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-[var(--bg-sunken)] border border-[var(--border-subtle)]">
                    <div
                      data-testid={`project-stats-task-bar-${t.task_id}`}
                      className="absolute inset-y-0 left-0 bg-[var(--accent)]"
                      style={{ width: widthPct }}
                    />
                  </div>
                </div>
                <span className="text-right font-mono-data text-tertiary text-[11px]">
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

  if (projectQ.isLoading) return <p className="text-tertiary text-[13px]">Loading…</p>;
  if (projectQ.error || !projectQ.data)
    return <p className="text-[var(--danger)] text-[13px]">Project not found.</p>;
  const project = projectQ.data;
  const topClasses = statsQ.data?.by_class.slice(0, 5) ?? [];

  return (
    <div className="mx-auto grid max-w-[1200px] gap-10">
      {/* ---- Editorial header ---- */}
      <motion.header
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
        className="flex items-start justify-between gap-6 flex-wrap"
      >
        <div className="grid gap-2 max-w-[640px]">
          <span className="font-mono-data text-[10px] tracking-[0.18em] uppercase text-tertiary">
            Project
          </span>
          <h1 className="text-[36px] sm:text-[44px] font-medium tracking-tight text-primary leading-tight">
            {project.name}
          </h1>
          {project.description && (
            <p className="text-[14px] text-secondary leading-relaxed">{project.description}</p>
          )}
        </div>
        {topClasses.length > 0 && (
          <div className="flex flex-wrap gap-1.5 max-w-[420px] justify-end">
            {topClasses.map((c, i) => (
              <motion.span
                key={c.class_id}
                initial={{ opacity: 0, x: 8 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: 0.1 + i * 0.04 }}
              >
                <Badge variant="ghost">
                  {c.name}
                  <span className="font-mono-data text-tertiary text-[10px]">{c.count}</span>
                </Badge>
              </motion.span>
            ))}
          </div>
        )}
      </motion.header>

      {/* ---- Stats strip ---- */}
      {statsQ.isLoading && <p className="text-tertiary text-[13px]">Loading stats…</p>}
      {statsQ.data && <ProjectStatsStrip stats={statsQ.data} />}
      {statsQ.error && !statsQ.isLoading && (
        <section className="rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-5 text-tertiary text-[13px]">
          No data yet.
        </section>
      )}

      {/* ---- Two-column layout ---- */}
      <div className="grid gap-8 grid-cols-1 lg:grid-cols-[2fr_1fr]">
        <section className="grid gap-4">
          <header className="flex items-end justify-between">
            <h2 className="text-[18px] font-medium tracking-tight text-primary">Tasks</h2>
            <span className="font-mono-data text-[11px] text-tertiary">
              {tasksQ.data?.length ?? 0} total
            </span>
          </header>
          <NewTaskDialog projectId={projectId} onCreated={() => {}} />
          {tasksQ.isLoading && <p className="text-tertiary text-[13px]">Loading tasks…</p>}
          <ul className="grid gap-2">
            {tasksQ.data?.map((t) => (
              <li key={t.id}>
                <Link
                  to="/projects/$projectId/tasks/$taskId"
                  params={{ projectId, taskId: t.id }}
                  className="block group"
                >
                  <Card
                    variant="glass"
                    className="flex items-center gap-3 px-4 py-3 transition-all group-hover:border-[var(--border-strong)] group-hover:-translate-y-px"
                  >
                    <span className="grid h-8 w-8 place-items-center rounded-[var(--radius-sm)] bg-[var(--bg-sunken)] text-[var(--accent)]">
                      {t.kind === "video" ? (
                        <Video className="h-4 w-4" />
                      ) : (
                        <ImageIcon className="h-4 w-4" />
                      )}
                    </span>
                    <span className="flex-1 text-[14px] tracking-tight text-primary">
                      {t.name}
                    </span>
                    <Badge variant="ghost">{t.kind}</Badge>
                    <ChevronRight className="h-4 w-4 text-tertiary transition-transform group-hover:translate-x-0.5" />
                  </Card>
                </Link>
              </li>
            ))}
            {(tasksQ.data?.length ?? 0) === 0 && !tasksQ.isLoading && (
              <li className="text-tertiary text-[13px] italic px-1">No tasks yet.</li>
            )}
          </ul>
        </section>
        <ClassesEditor projectId={projectId} />
      </div>
    </div>
  );
}
