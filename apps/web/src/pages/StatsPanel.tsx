import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Bar,
  BarChart,
  Cell,
  Legend,
  Pie,
  PieChart,
  Tooltip,
  XAxis,
  YAxis,
  ResponsiveContainer,
} from "recharts";
import {
  BarChart3,
  ChartPie,
  Clock,
  Inbox,
  MapPin,
  Ruler,
  Sparkles,
  Users,
} from "lucide-react";
import { tasksApi } from "@/api/tasks";
import {
  statsApi,
  type AspectRatio,
  type AspectRatioBucket,
  type ClassFrequencyRow,
  type Heatmap,
  type ProjectStats,
  type SizeDistribution,
  type TaskProgress,
  type TimeOnTaskRow,
} from "@/api/stats";
import { Select } from "@/components/ui/Select";
import { QualityDashboard } from "@/components/stats/QualityDashboard";
import { cn } from "@/lib/cn";

// ---------------------------------------------------------------------------
// Public props — accept either a single task or a project (project picks 1st task).
// ---------------------------------------------------------------------------
export interface StatsPanelProps {
  taskId?: string;
  projectId?: string;
}

// ---------------------------------------------------------------------------
// Shared styling
//
// v2.8 Wave 3 — cards become glass-surface rounded-2xl with a specular
// highlight, but we KEEP `p-3` and `min-h-[200px]` to satisfy the
// existing widget-density test expectations (see stats-widget-density.test.tsx).
// ---------------------------------------------------------------------------
const cardClass =
  "relative flex flex-col gap-2 min-h-[200px] rounded-2xl glass-surface glass-specular p-3";
const headingClass =
  "relative z-10 font-mono text-[10px] uppercase tracking-[0.18em] text-[color:var(--text-tertiary)] font-medium flex items-center gap-1.5 leading-none";
const placeholderClass = "text-[13px] text-[color:var(--text-tertiary)]";
const errorClass = "text-[13px] text-[color:var(--danger)]";

const SIZE_COLORS: Record<keyof SizeDistribution, string> = {
  small: "oklch(0.78 0.16 215)",
  medium: "oklch(0.66 0.20 285)",
  large: "oklch(0.74 0.17 60)",
};

const ASPECT_BUCKETS: AspectRatioBucket[] = [
  "<0.33",
  "0.33-0.67",
  "0.67-1.5",
  "1.5-3",
  ">=3",
];

function formatSeconds(s: number): string {
  if (!Number.isFinite(s) || s <= 0) return "0s";
  if (s < 60) return `${Math.round(s)}s`;
  const m = Math.floor(s / 60);
  const r = Math.round(s - m * 60);
  return `${m}m ${r}s`;
}

// ---------------------------------------------------------------------------
// Reusable empty-state block — used by every widget when its dataset is empty.
// ---------------------------------------------------------------------------
interface EmptyStateProps {
  icon: React.ReactNode;
  title: string;
  hint?: string;
}
function EmptyState({ icon, title, hint: _hint }: EmptyStateProps) {
  // Compact empty state: small icon (16px) + 1-line message. Hint dropped to
  // keep cards tight when the dataset is empty, per v2.6 layout-density spec.
  return (
    <div
      data-testid="stats-empty-state"
      className="flex flex-1 items-center justify-center gap-2 py-2 text-center"
    >
      <span
        aria-hidden
        className="grid h-4 w-4 place-items-center text-[color:var(--text-tertiary)] shrink-0"
      >
        {icon}
      </span>
      <p className="text-[12px] text-[color:var(--text-tertiary)] tracking-tight truncate">
        {title}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 1. Class frequency
// ---------------------------------------------------------------------------
function ClassFrequencyCard({ taskId }: { taskId: string }) {
  const q = useQuery<ClassFrequencyRow[]>({
    queryKey: ["stats", "class-frequency", taskId],
    queryFn: () => statsApi.classFrequency(taskId),
  });
  const total = useMemo(
    () => (q.data ?? []).reduce((acc, r) => acc + r.count, 0),
    [q.data],
  );
  return (
    <div className={cardClass} data-testid="stats-card-class-frequency">
      <h3 className={headingClass}>
        <BarChart3 className="h-3.5 w-3.5" /> Class frequency
      </h3>
      {q.isLoading && <p className={placeholderClass}>Loading…</p>}
      {q.isError && <p className={errorClass}>Failed to load.</p>}
      {q.data && total === 0 && (
        <EmptyState
          icon={<BarChart3 className="h-4 w-4" />}
          title="No annotations yet"
          hint="Start annotating to see how often each class appears."
        />
      )}
      {q.data && total > 0 && (
        <>
          <ResponsiveContainer width="100%" height={140}>
            <BarChart
              data={q.data}
              layout="vertical"
              margin={{ left: 0, right: 8, top: 0, bottom: 0 }}
            >
              <XAxis type="number" hide />
              <YAxis
                type="category"
                dataKey="class_name"
                width={70}
                tick={{ fontSize: 10.5 }}
              />
              <Tooltip />
              <Bar dataKey="count">
                {q.data.map((row) => (
                  <Cell key={row.class_id} fill={row.class_color} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
          <ul className="m-0 pl-4 text-[11.5px] list-disc leading-tight">
            {q.data.map((r) => {
              const pct = total > 0 ? Math.round((r.count / total) * 100) : 0;
              return (
                <li key={r.class_id} style={{ color: r.class_color }}>
                  {r.class_name}: {r.count} ({pct}%)
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 2. Task progress
// ---------------------------------------------------------------------------
function ProgressCard({ taskId }: { taskId: string }) {
  const q = useQuery<TaskProgress>({
    queryKey: ["stats", "progress", taskId],
    queryFn: () => statsApi.progress(taskId),
  });
  return (
    <div className={cardClass} data-testid="stats-card-progress">
      <h3 className={headingClass}>
        <ChartPie className="h-3.5 w-3.5" /> Task progress
      </h3>
      {q.isLoading && <p className={placeholderClass}>Loading…</p>}
      {q.isError && <p className={errorClass}>Failed to load.</p>}
      {q.data && q.data.total_frames === 0 && (
        <EmptyState
          icon={<Inbox className="h-4 w-4" />}
          title="No frames yet"
          hint="Upload assets to populate frames and unlock progress tracking."
        />
      )}
      {q.data && q.data.total_frames > 0 && (
        <>
          <ResponsiveContainer width="100%" height={130}>
            <PieChart margin={{ top: 0, right: 0, bottom: 0, left: 0 }}>
              <Pie
                data={[
                  { name: "labeled", value: q.data.labeled_frames },
                  {
                    name: "unlabeled",
                    value: Math.max(
                      0,
                      q.data.total_frames - q.data.labeled_frames,
                    ),
                  },
                ]}
                dataKey="value"
                innerRadius={36}
                outerRadius={58}
                startAngle={90}
                endAngle={-270}
              >
                <Cell fill="rgb(120, 220, 160)" />
                <Cell fill="rgba(255,255,255,0.1)" />
              </Pie>
              <Tooltip />
            </PieChart>
          </ResponsiveContainer>
          <p className="text-center font-mono text-[12px] text-[color:var(--text-secondary)] tabular-tight leading-tight">
            {q.data.labeled_frames} / {q.data.total_frames} frames
          </p>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 3. Size distribution
// ---------------------------------------------------------------------------
function SizeDistributionCard({ taskId }: { taskId: string }) {
  const q = useQuery<SizeDistribution>({
    queryKey: ["stats", "size-distribution", taskId],
    queryFn: () => statsApi.sizeDistribution(taskId),
  });
  const data = useMemo(() => {
    if (!q.data) return [];
    return (Object.keys(SIZE_COLORS) as Array<keyof SizeDistribution>).map(
      (key) => ({
        name: key,
        value: q.data![key],
        fill: SIZE_COLORS[key],
      }),
    );
  }, [q.data]);
  const total = data.reduce((acc, d) => acc + d.value, 0);
  return (
    <div className={cardClass} data-testid="stats-card-size-distribution">
      <h3 className={headingClass}>
        <Ruler className="h-3.5 w-3.5" /> Size distribution
      </h3>
      {q.isLoading && <p className={placeholderClass}>Loading…</p>}
      {q.isError && <p className={errorClass}>Failed to load.</p>}
      {q.data && total === 0 && (
        <EmptyState
          icon={<Ruler className="h-4 w-4" />}
          title="No annotations yet"
          hint="Object sizes (small / medium / large) appear once annotations exist."
        />
      )}
      {q.data && total > 0 && (
        <>
          <ResponsiveContainer width="100%" height={130}>
            <PieChart margin={{ top: 0, right: 0, bottom: 0, left: 0 }}>
              <Pie data={data} dataKey="value" innerRadius={36} outerRadius={58}>
                {data.map((d) => (
                  <Cell key={d.name} fill={d.fill} />
                ))}
              </Pie>
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Tooltip />
            </PieChart>
          </ResponsiveContainer>
          <ul className="m-0 pl-4 text-[11.5px] list-disc leading-tight">
            {data.map((d) => (
              <li key={d.name} style={{ color: d.fill }}>
                {d.name}: {d.value}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 4. Spatial heatmap
// ---------------------------------------------------------------------------
function HeatmapCard({ taskId }: { taskId: string }) {
  const q = useQuery<Heatmap>({
    queryKey: ["stats", "heatmap", taskId],
    queryFn: () => statsApi.heatmap(taskId, 32),
  });
  const max = useMemo(
    () => (q.data ? q.data.grid.reduce((m, v) => (v > m ? v : m), 0) : 0),
    [q.data],
  );
  return (
    <div className={cardClass} data-testid="stats-card-heatmap">
      <h3 className={headingClass}>
        <MapPin className="h-3.5 w-3.5" /> Spatial heatmap
      </h3>
      {q.isLoading && <p className={placeholderClass}>Loading…</p>}
      {q.isError && <p className={errorClass}>Failed to load.</p>}
      {q.data && max === 0 && (
        <EmptyState
          icon={<MapPin className="h-4 w-4" />}
          title="No spatial data yet"
          hint="Annotation positions are aggregated into a 32x32 grid once you start labelling."
        />
      )}
      {q.data && max > 0 && (
        <div
          className="mx-auto w-full max-w-[160px]"
          style={{
            display: "grid",
            gridTemplateColumns: `repeat(${q.data.bins}, 1fr)`,
            gridTemplateRows: `repeat(${q.data.bins}, 1fr)`,
            gap: 0,
            aspectRatio: "1 / 1",
            border: "1px solid rgba(255,255,255,0.08)",
          }}
        >
          {q.data.grid.map((count, i) => {
            const intensity = max > 0 ? count / max : 0;
            return (
              <div
                key={i}
                data-testid="heatmap-cell"
                title={String(count)}
                style={{
                  background: `rgba(220, 38, 38, ${intensity.toFixed(3)})`,
                }}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 5. Aspect ratio histogram
// ---------------------------------------------------------------------------
function AspectRatioCard({ taskId }: { taskId: string }) {
  const q = useQuery<AspectRatio>({
    queryKey: ["stats", "aspect-ratio", taskId],
    queryFn: () => statsApi.aspectRatio(taskId),
  });
  const data = useMemo(() => {
    if (!q.data) return [];
    return ASPECT_BUCKETS.map((b) => ({ name: b, value: q.data![b] }));
  }, [q.data]);
  const total = data.reduce((acc, d) => acc + d.value, 0);
  return (
    <div className={cardClass} data-testid="stats-card-aspect-ratio">
      <h3 className={headingClass}>
        <Sparkles className="h-3.5 w-3.5" /> Aspect ratio
      </h3>
      {q.isLoading && <p className={placeholderClass}>Loading…</p>}
      {q.isError && <p className={errorClass}>Failed to load.</p>}
      {q.data && total === 0 && (
        <EmptyState
          icon={<Sparkles className="h-4 w-4" />}
          title="No annotations yet"
          hint="Aspect-ratio buckets fill in automatically once boxes / masks land."
        />
      )}
      {q.data && total > 0 && (
        <ResponsiveContainer width="100%" height={140}>
          <BarChart data={data} margin={{ left: 0, right: 4, top: 4, bottom: 0 }}>
            <XAxis dataKey="name" tick={{ fontSize: 10.5 }} />
            <YAxis allowDecimals={false} tick={{ fontSize: 10.5 }} width={28} />
            <Tooltip />
            <Bar dataKey="value" fill="rgb(150, 200, 255)" />
          </BarChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 6. Time on task
// ---------------------------------------------------------------------------
function TimeOnTaskCard({ taskId }: { taskId: string }) {
  const q = useQuery<TimeOnTaskRow[]>({
    queryKey: ["stats", "time-on-task", taskId],
    queryFn: () => statsApi.timeOnTask(taskId),
  });
  return (
    <div className={cardClass} data-testid="stats-card-time-on-task">
      <h3 className={headingClass}>
        <Clock className="h-3.5 w-3.5" /> Time on task
      </h3>
      {q.isLoading && <p className={placeholderClass}>Loading…</p>}
      {q.isError && <p className={errorClass}>Failed to load.</p>}
      {q.data && q.data.length === 0 && (
        <EmptyState
          icon={<Users className="h-4 w-4" />}
          title="No annotators yet"
          hint="Per-user time accumulates after the first annotation lands."
        />
      )}
      {q.data && q.data.length > 0 && (
        <ul className="m-0 p-0 list-none text-[12px]">
          {q.data.map((row) => (
            <li
              key={row.user_id}
              className="flex h-7 items-center justify-between gap-2 border-b border-[var(--border-subtle)] last:border-b-0"
            >
              <span className="text-[color:var(--text-secondary)] tracking-tight truncate">
                {row.email}
              </span>
              <span className="font-mono text-[color:var(--text-tertiary)] tabular-tight shrink-0">
                {formatSeconds(row.seconds)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Internal grid that renders all six widgets for a given task.
// ---------------------------------------------------------------------------
function StatsGrid({ taskId }: { taskId: string }) {
  return (
    <div
      className="grid gap-3 grid-cols-1 lg:grid-cols-2 auto-rows-min"
      data-testid="stats-grid"
    >
      <ClassFrequencyCard taskId={taskId} />
      <ProgressCard taskId={taskId} />
      <SizeDistributionCard taskId={taskId} />
      <HeatmapCard taskId={taskId} />
      <AspectRatioCard taskId={taskId} />
      <TimeOnTaskCard taskId={taskId} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Project rollup — compact project-level summary that mirrors
// ProjectStatsStrip's data (totals + by_class + per-task progress) but renders
// in a tighter layout to feel different from the Overview tab. v3.3 Issue 1.
// ---------------------------------------------------------------------------
function ProjectRollup({ projectId }: { projectId: string }) {
  const q = useQuery<ProjectStats>({
    queryKey: ["stats", "project", projectId],
    queryFn: () => statsApi.projectStats(projectId),
  });

  if (q.isLoading) {
    return (
      <p className={placeholderClass} data-testid="stats-rollup-loading">
        Loading rollup…
      </p>
    );
  }
  if (q.isError || !q.data) {
    return (
      <p className={errorClass} data-testid="stats-rollup-error">
        Failed to load rollup.
      </p>
    );
  }

  const { totals, by_class, tasks } = q.data;
  const completionPct =
    tasks.length > 0
      ? Math.round(
          (tasks.reduce((acc, t) => acc + Math.max(0, Math.min(1, t.progress_pct)), 0) /
            tasks.length) *
            100,
        )
      : 0;

  return (
    <section
      data-testid="project-rollup"
      className="relative grid gap-3 rounded-2xl glass-surface glass-specular p-4"
    >
      <header className="flex items-baseline justify-between gap-3">
        <h3 className={headingClass}>
          <Sparkles className="h-3.5 w-3.5" /> Project rollup
        </h3>
      </header>

      <div className="flex flex-wrap gap-4">
        <div data-testid="rollup-totals-annotations" className="grid gap-0.5">
          <span className="font-mono text-[24px] leading-none text-[color:var(--text-primary)] font-semibold tabular-tight">
            {totals.annotations}
          </span>
          <span className="font-mono text-[10px] tracking-[0.18em] uppercase text-[color:var(--text-tertiary)]">
            Annotations
          </span>
        </div>
        <div data-testid="rollup-totals-assets" className="grid gap-0.5">
          <span className="font-mono text-[24px] leading-none text-[color:var(--text-primary)] font-semibold tabular-tight">
            {totals.assets}
          </span>
          <span className="font-mono text-[10px] tracking-[0.18em] uppercase text-[color:var(--text-tertiary)]">
            Assets
          </span>
        </div>
        <div data-testid="rollup-totals-completion" className="grid gap-0.5">
          <span className="font-mono text-[24px] leading-none text-[color:var(--text-primary)] font-semibold tabular-tight">
            {completionPct}%
          </span>
          <span className="font-mono text-[10px] tracking-[0.18em] uppercase text-[color:var(--text-tertiary)]">
            Completion
          </span>
        </div>
      </div>

      {by_class.length > 0 && (
        <ul
          data-testid="rollup-by-class"
          className="flex flex-wrap gap-1.5 m-0 p-0 list-none"
        >
          {by_class.slice(0, 12).map((c) => (
            <li
              key={c.class_id}
              className="inline-flex items-center gap-1.5 rounded-full border border-[var(--border-subtle)] px-2 py-0.5 text-[11.5px] text-[color:var(--text-secondary)]"
            >
              <span className="truncate max-w-[140px]">{c.name}</span>
              <span className="font-mono text-[10px] tabular-nums text-[color:var(--text-tertiary)]">
                {c.count}
              </span>
            </li>
          ))}
        </ul>
      )}

      {tasks.length > 0 && (
        <ul data-testid="rollup-task-bars" className="grid gap-1.5 m-0 p-0 list-none">
          {tasks.map((t) => {
            const pct = Math.round(
              Math.min(Math.max(t.progress_pct, 0), 1) * 100,
            );
            return (
              <li
                key={t.task_id}
                className="grid grid-cols-[1fr_44px] items-center gap-3 text-[12px]"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <span
                    className="min-w-[80px] max-w-[180px] text-[color:var(--text-secondary)] tracking-tight truncate"
                    title={t.name}
                  >
                    {t.name}
                  </span>
                  <div className="relative h-1 flex-1 overflow-hidden rounded-full bg-[var(--bg-hover)]">
                    <div
                      data-testid={`rollup-task-bar-${t.task_id}`}
                      className="absolute inset-y-0 left-0 bg-[var(--accent)]"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>
                <span className="text-right font-mono text-[10.5px] text-[color:var(--text-tertiary)] tabular-nums">
                  {pct}%
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
// Project-mode wrapper — v3.3 Issue 1. Renders:
//   • Project rollup at the top (project-wide totals + by-class + per-task).
//   • Per-task deep-dive grid below, with a task selector to choose which
//     task's six widgets to view (default: tasks[0]).
// If the project has no tasks, we render a clean empty state.
// ---------------------------------------------------------------------------
function ProjectStatsPanel({ projectId }: { projectId: string }) {
  const tasksQ = useQuery({
    queryKey: ["tasks", projectId],
    queryFn: () => tasksApi.listForProject(projectId),
  });

  const tasks = tasksQ.data ?? [];
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(
    tasks[0]?.id ?? null,
  );

  // Initialize / reconcile selection once the tasks list resolves. We avoid
  // resetting on every render so the user's pick survives re-renders, but we
  // DO fall back to tasks[0] when the previous selection is no longer in the
  // list (e.g., task deleted).
  useEffect(() => {
    if (tasks.length === 0) {
      if (selectedTaskId !== null) setSelectedTaskId(null);
      return;
    }
    if (
      selectedTaskId === null ||
      !tasks.some((t) => t.id === selectedTaskId)
    ) {
      setSelectedTaskId(tasks[0].id);
    }
    // We intentionally depend on the tasks identity (re-fetch result) rather
    // than the selection itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks]);

  if (tasksQ.isLoading) {
    return <p className={placeholderClass}>Loading tasks…</p>;
  }
  if (tasksQ.isError) {
    return <p className={errorClass}>Failed to load tasks.</p>;
  }
  if (tasks.length === 0) {
    return (
      <section className="grid gap-4">
        <ProjectRollup projectId={projectId} />
        <div
          className="relative rounded-2xl glass-surface p-8"
          data-testid="stats-no-tasks"
        >
          <EmptyState
            icon={<Inbox className="h-4 w-4" />}
            title="No tasks in this project yet"
            hint="Create a task and upload assets to start collecting stats."
          />
        </div>
      </section>
    );
  }

  const selectedTask =
    tasks.find((t) => t.id === selectedTaskId) ?? tasks[0];

  return (
    <section className="grid gap-4">
      <ProjectRollup projectId={projectId} />
      <header
        data-testid="per-task-header"
        className="flex items-center justify-between gap-3 flex-wrap"
      >
        <p className="text-[12px] text-[color:var(--text-tertiary)] tracking-tight">
          Per-task analytics — task:{" "}
          <span className="font-medium text-[color:var(--text-secondary)]">
            {selectedTask.name}
          </span>
        </p>
        {tasks.length > 1 && (
          <Select
            value={selectedTask.id}
            onValueChange={(v) => setSelectedTaskId(v)}
          >
            <Select.Trigger
              aria-label="Select task"
              data-testid="per-task-selector"
              className="min-w-[180px]"
            />
            <Select.Content>
              {tasks.map((t) => (
                <Select.Item
                  key={t.id}
                  value={t.id}
                  data-testid={`per-task-option-${t.id}`}
                >
                  {t.name}
                </Select.Item>
              ))}
            </Select.Content>
          </Select>
        )}
      </header>
      <StatsGrid taskId={selectedTask.id} />
    </section>
  );
}

// ---------------------------------------------------------------------------
// Plan-13 Phase 7 Task 11 — project-scope tabs (Stats vs. Quality).
// ---------------------------------------------------------------------------
function ProjectStatsTabs({ projectId }: { projectId: string }) {
  const [tab, setTab] = useState<"stats" | "quality">("stats");
  const tabs: Array<{ value: "stats" | "quality"; label: string }> = [
    { value: "stats", label: "Overview" },
    { value: "quality", label: "Quality" },
  ];
  return (
    <section className="grid gap-4" data-testid="stats-panel-project">
      <nav
        aria-label="Stats tabs"
        data-testid="stats-tabs"
        className="inline-flex gap-1 self-start"
      >
        {tabs.map((t) => (
          <button
            key={t.value}
            type="button"
            data-testid={`stats-tab-${t.value}`}
            aria-pressed={tab === t.value}
            onClick={() => setTab(t.value)}
            className={cn(
              "px-3 py-1 rounded-full text-[12px] tracking-tight transition-colors",
              tab === t.value
                ? "bg-[var(--accent)] text-[color:var(--accent-fg)]"
                : "bg-[var(--bg-subtle)] text-[color:var(--text-secondary)] hover:bg-[var(--bg-hover)]",
            )}
          >
            {t.label}
          </button>
        ))}
      </nav>
      {tab === "stats" ? (
        <ProjectStatsPanel projectId={projectId} />
      ) : (
        <QualityDashboard projectId={projectId} />
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Public entry point.
// ---------------------------------------------------------------------------
export function StatsPanel({ taskId, projectId }: StatsPanelProps) {
  if (taskId) {
    return (
      <section className="grid gap-4" data-testid="stats-panel-task">
        <h2 className="font-editorial text-[24px] leading-none text-[color:var(--text-primary)]">
          Stats
        </h2>
        <StatsGrid taskId={taskId} />
      </section>
    );
  }
  if (projectId) {
    return <ProjectStatsTabs projectId={projectId} />;
  }
  return (
    <p className={errorClass}>StatsPanel requires either taskId or projectId.</p>
  );
}
