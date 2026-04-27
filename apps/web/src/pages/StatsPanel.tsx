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
  statsApi,
  type AspectRatio,
  type AspectRatioBucket,
  type ClassFrequencyRow,
  type Heatmap,
  type SizeDistribution,
  type TaskProgress,
  type TimeOnTaskRow,
} from "@/api/stats";

interface Props {
  taskId: string;
}

const cardClass =
  "flex flex-col gap-3 min-h-[240px] rounded-[var(--radius-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-5";
const headingClass =
  "text-[12px] uppercase tracking-[0.10em] text-tertiary font-medium";
const placeholderClass = "text-[13px] text-tertiary";
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
    <div className={cardClass}>
      <h3 className={headingClass}>Class frequency</h3>
      {q.isLoading && <p className={placeholderClass}>Loading…</p>}
      {q.isError && <p className={errorClass}>Failed to load.</p>}
      {q.data && total === 0 && (
        <>
          <p className={placeholderClass}>No annotations yet</p>
          <ul className="m-0 pl-4 text-[12px] opacity-70 list-disc">
            {q.data.map((r) => (
              <li key={r.class_id} style={{ color: r.class_color }}>
                {r.class_name}: 0 (0%)
              </li>
            ))}
          </ul>
        </>
      )}
      {q.data && total > 0 && (
        <>
          <ResponsiveContainer width="100%" height={180}>
            <BarChart data={q.data} layout="vertical" margin={{ left: 8, right: 16 }}>
              <XAxis type="number" hide />
              <YAxis type="category" dataKey="class_name" width={80} tick={{ fontSize: 11 }} />
              <Tooltip />
              <Bar dataKey="count">
                {q.data.map((row) => (
                  <Cell key={row.class_id} fill={row.class_color} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
          <ul className="m-0 pl-4 text-[12px] list-disc">
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

function ProgressCard({ taskId }: { taskId: string }) {
  const q = useQuery<TaskProgress>({
    queryKey: ["stats", "progress", taskId],
    queryFn: () => statsApi.progress(taskId),
  });
  return (
    <div className={cardClass}>
      <h3 className={headingClass}>Task progress</h3>
      {q.isLoading && <p className={placeholderClass}>Loading…</p>}
      {q.isError && <p className={errorClass}>Failed to load.</p>}
      {q.data && q.data.total_frames === 0 && (
        <p className={placeholderClass}>No frames yet</p>
      )}
      {q.data && q.data.total_frames > 0 && (
        <>
          <ResponsiveContainer width="100%" height={160}>
            <PieChart>
              <Pie
                data={[
                  { name: "labeled", value: q.data.labeled_frames },
                  {
                    name: "unlabeled",
                    value: Math.max(0, q.data.total_frames - q.data.labeled_frames),
                  },
                ]}
                dataKey="value"
                innerRadius={45}
                outerRadius={70}
                startAngle={90}
                endAngle={-270}
              >
                <Cell fill="rgb(120, 220, 160)" />
                <Cell fill="rgba(255,255,255,0.1)" />
              </Pie>
              <Tooltip />
            </PieChart>
          </ResponsiveContainer>
          <p className="text-center font-mono-data text-[13px] text-secondary">
            {q.data.labeled_frames} / {q.data.total_frames} frames
          </p>
        </>
      )}
    </div>
  );
}

function SizeDistributionCard({ taskId }: { taskId: string }) {
  const q = useQuery<SizeDistribution>({
    queryKey: ["stats", "size-distribution", taskId],
    queryFn: () => statsApi.sizeDistribution(taskId),
  });
  const data = useMemo(() => {
    if (!q.data) return [];
    return (Object.keys(SIZE_COLORS) as Array<keyof SizeDistribution>).map((key) => ({
      name: key,
      value: q.data![key],
      fill: SIZE_COLORS[key],
    }));
  }, [q.data]);
  const total = data.reduce((acc, d) => acc + d.value, 0);
  return (
    <div className={cardClass}>
      <h3 className={headingClass}>Size distribution</h3>
      {q.isLoading && <p className={placeholderClass}>Loading…</p>}
      {q.isError && <p className={errorClass}>Failed to load.</p>}
      {q.data && total === 0 && (
        <>
          <p className={placeholderClass}>No annotations yet</p>
          <ul className="m-0 pl-4 text-[12px] opacity-70 list-disc">
            {data.map((d) => (
              <li key={d.name} style={{ color: d.fill }}>
                {d.name}: 0
              </li>
            ))}
          </ul>
        </>
      )}
      {q.data && total > 0 && (
        <>
          <ResponsiveContainer width="100%" height={160}>
            <PieChart>
              <Pie data={data} dataKey="value" innerRadius={45} outerRadius={70}>
                {data.map((d) => (
                  <Cell key={d.name} fill={d.fill} />
                ))}
              </Pie>
              <Legend />
              <Tooltip />
            </PieChart>
          </ResponsiveContainer>
          <ul className="m-0 pl-4 text-[12px] list-disc">
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
    <div className={cardClass}>
      <h3 className={headingClass}>Spatial heatmap</h3>
      {q.isLoading && <p className={placeholderClass}>Loading…</p>}
      {q.isError && <p className={errorClass}>Failed to load.</p>}
      {q.data && (
        <div
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

function AspectRatioCard({ taskId }: { taskId: string }) {
  const q = useQuery<AspectRatio>({
    queryKey: ["stats", "aspect-ratio", taskId],
    queryFn: () => statsApi.aspectRatio(taskId),
  });
  const data = useMemo(() => {
    if (!q.data) return [];
    return ASPECT_BUCKETS.map((b) => ({ name: b, value: q.data![b] }));
  }, [q.data]);
  return (
    <div className={cardClass}>
      <h3 className={headingClass}>Aspect ratio</h3>
      {q.isLoading && <p className={placeholderClass}>Loading…</p>}
      {q.isError && <p className={errorClass}>Failed to load.</p>}
      {q.data && (
        <ResponsiveContainer width="100%" height={180}>
          <BarChart data={data} margin={{ left: 8, right: 8, top: 8, bottom: 8 }}>
            <XAxis dataKey="name" tick={{ fontSize: 11 }} />
            <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
            <Tooltip />
            <Bar dataKey="value" fill="rgb(150, 200, 255)" />
          </BarChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}

function TimeOnTaskCard({ taskId }: { taskId: string }) {
  const q = useQuery<TimeOnTaskRow[]>({
    queryKey: ["stats", "time-on-task", taskId],
    queryFn: () => statsApi.timeOnTask(taskId),
  });
  return (
    <div className={cardClass}>
      <h3 className={headingClass}>Time on task</h3>
      {q.isLoading && <p className={placeholderClass}>Loading…</p>}
      {q.isError && <p className={errorClass}>Failed to load.</p>}
      {q.data && q.data.length === 0 && (
        <p className={placeholderClass}>No annotators yet</p>
      )}
      {q.data && q.data.length > 0 && (
        <ul className="m-0 p-0 list-none text-[13px]">
          {q.data.map((row) => (
            <li
              key={row.user_id}
              className="flex justify-between py-1 border-b border-[var(--border-subtle)]"
            >
              <span className="text-secondary tracking-tight">{row.email}</span>
              <span className="font-mono-data text-tertiary">{formatSeconds(row.seconds)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function StatsPanel({ taskId }: Props) {
  return (
    <section className="grid gap-4">
      <h2 className="text-[18px] font-medium tracking-tight text-primary">Stats</h2>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <ClassFrequencyCard taskId={taskId} />
        <ProgressCard taskId={taskId} />
        <SizeDistributionCard taskId={taskId} />
        <HeatmapCard taskId={taskId} />
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <AspectRatioCard taskId={taskId} />
        <TimeOnTaskCard taskId={taskId} />
      </div>
    </section>
  );
}
