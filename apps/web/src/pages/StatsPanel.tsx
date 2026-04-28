import { useMemo } from "react";
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
  type SizeDistribution,
  type TaskProgress,
  type TimeOnTaskRow,
} from "@/api/stats";

// ---------------------------------------------------------------------------
// Public props — accept either a single task or a project (project picks 1st task).
// ---------------------------------------------------------------------------
export interface StatsPanelProps {
  taskId?: string;
  projectId?: string;
}

// ---------------------------------------------------------------------------
// Shared styling
// ---------------------------------------------------------------------------
const cardClass =
  "flex flex-col gap-2 min-h-[200px] rounded-[var(--radius-lg)] border border-[var(--border-subtle)] bg-[var(--bg-elev)] p-3";
const headingClass =
  "text-[11px] uppercase tracking-[0.08em] text-[color:var(--text-tertiary)] font-medium flex items-center gap-1.5 leading-none";
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
          <p className="text-center font-mono text-[12px] text-[color:var(--text-secondary)] tabular-nums leading-tight">
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
              <span className="font-mono text-[color:var(--text-tertiary)] tabular-nums shrink-0">
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
// Project-mode wrapper — picks the first task, since stats are task-scoped
// in the API. If the project has no tasks, we render a clean empty state.
// ---------------------------------------------------------------------------
function ProjectStatsPanel({ projectId }: { projectId: string }) {
  const tasksQ = useQuery({
    queryKey: ["tasks", projectId],
    queryFn: () => tasksApi.listForProject(projectId),
  });

  if (tasksQ.isLoading) {
    return <p className={placeholderClass}>Loading tasks…</p>;
  }
  if (tasksQ.isError) {
    return <p className={errorClass}>Failed to load tasks.</p>;
  }
  const tasks = tasksQ.data ?? [];
  if (tasks.length === 0) {
    return (
      <div
        className="rounded-[var(--radius-lg)] border border-[var(--border-subtle)] bg-[var(--bg-elev)] p-8"
        data-testid="stats-no-tasks"
      >
        <EmptyState
          icon={<Inbox className="h-4 w-4" />}
          title="No tasks in this project yet"
          hint="Create a task and upload assets to start collecting stats."
        />
      </div>
    );
  }

  // First task by default. Future enhancement: dropdown selector.
  const primary = tasks[0];
  return (
    <section className="grid gap-4">
      <header className="flex items-baseline justify-between gap-3">
        <p className="text-[12px] text-[color:var(--text-tertiary)] tracking-tight">
          Showing stats for{" "}
          <span className="font-medium text-[color:var(--text-secondary)]">
            {primary.name}
          </span>
          {tasks.length > 1 && (
            <>
              {" "}
              <span className="text-[color:var(--text-tertiary)]">
                ({tasks.length} tasks total)
              </span>
            </>
          )}
        </p>
      </header>
      <StatsGrid taskId={primary.id} />
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
        <h2 className="text-[16px] font-medium tracking-tight text-[color:var(--text-primary)]">
          Stats
        </h2>
        <StatsGrid taskId={taskId} />
      </section>
    );
  }
  if (projectId) {
    return (
      <section className="grid gap-4" data-testid="stats-panel-project">
        <ProjectStatsPanel projectId={projectId} />
      </section>
    );
  }
  return (
    <p className={errorClass}>StatsPanel requires either taskId or projectId.</p>
  );
}
