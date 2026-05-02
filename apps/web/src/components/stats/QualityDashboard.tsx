import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  qualityApi,
  type PerClassQualityRow,
  type ReviewerQualityRow,
  type RetrainRow,
} from "@/api/quality";
import { tasksApi } from "@/api/tasks";
import { cn } from "@/lib/cn";

interface QualityDashboardProps {
  projectId: string;
  /** Optional pinned task — if absent, defaults to the project's first task. */
  taskId?: string;
}

type RangePreset = "7d" | "30d" | "90d";

function presetToFromIso(preset: RangePreset): string {
  const days = preset === "7d" ? 7 : preset === "30d" ? 30 : 90;
  const d = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return d.toISOString();
}

const cardClass =
  "relative flex flex-col gap-3 rounded-2xl glass-surface glass-specular p-4";
const headingClass =
  "font-mono text-[10px] uppercase tracking-[0.18em] text-[color:var(--text-tertiary)] font-medium";

export function QualityDashboard({ projectId, taskId }: QualityDashboardProps) {
  const [preset, setPreset] = useState<RangePreset>("30d");
  const fromIso = useMemo(() => presetToFromIso(preset), [preset]);

  return (
    <section className="grid gap-4" data-testid="quality-dashboard">
      <header className="flex items-center justify-between gap-3">
        <h2 className="font-editorial text-[20px] leading-none text-[color:var(--text-primary)]">
          Quality
        </h2>
        <RangeChips preset={preset} onChange={setPreset} />
      </header>

      <ReviewerQualitySection projectId={projectId} fromIso={fromIso} />
      <PerClassPrecisionSection projectId={projectId} taskId={taskId} />
      <RetrainHistorySection projectId={projectId} />
    </section>
  );
}

function RangeChips({
  preset,
  onChange,
}: {
  preset: RangePreset;
  onChange: (p: RangePreset) => void;
}) {
  const options: RangePreset[] = ["7d", "30d", "90d"];
  return (
    <nav
      data-testid="quality-range-chips"
      aria-label="Time range"
      className="inline-flex gap-1"
    >
      {options.map((opt) => (
        <button
          key={opt}
          type="button"
          data-testid={`quality-range-${opt}`}
          aria-pressed={preset === opt}
          onClick={() => onChange(opt)}
          className={cn(
            "px-2.5 py-1 rounded-full text-[11.5px] tracking-tight transition-colors",
            preset === opt
              ? "bg-[var(--accent)] text-[color:var(--accent-fg)]"
              : "bg-[var(--bg-subtle)] text-[color:var(--text-secondary)] hover:bg-[var(--bg-hover)]",
          )}
        >
          {opt}
        </button>
      ))}
    </nav>
  );
}

// ---------------------------------------------------------------------------
// Reviewer quality
// ---------------------------------------------------------------------------
function ReviewerQualitySection({
  projectId,
  fromIso,
}: {
  projectId: string;
  fromIso: string;
}) {
  const q = useQuery<ReviewerQualityRow[]>({
    queryKey: ["quality/reviewer", projectId, fromIso],
    queryFn: () => qualityApi.reviewerQuality(projectId, { from: fromIso }),
  });
  const rows = q.data ?? [];

  return (
    <div className={cardClass} data-testid="quality-reviewer-card">
      <h3 className={headingClass}>Reviewer quality</h3>
      {q.isLoading && (
        <p className="text-[12px] text-[color:var(--text-tertiary)]">
          Loading…
        </p>
      )}
      {q.isError && (
        <p className="text-[12px] text-[color:var(--danger)]">
          Failed to load.
        </p>
      )}
      {!q.isLoading && rows.length === 0 && (
        <p className="text-[12px] text-[color:var(--text-tertiary)]">
          No reviews in this window yet.
        </p>
      )}
      {rows.length > 0 && (
        <table
          data-testid="quality-reviewer-table"
          className="w-full text-[12.5px] tabular-nums"
        >
          <thead className="text-[10px] uppercase tracking-wider text-[color:var(--text-tertiary)]">
            <tr>
              <th className="text-left py-1">Reviewer</th>
              <th className="text-right py-1">Reviewed</th>
              <th className="text-right py-1">Accepted</th>
              <th className="text-right py-1">Rejected</th>
              <th className="text-right py-1">Accept rate</th>
              <th className="py-1 w-24">Trend</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={row.reviewer_id}
                data-testid={`quality-reviewer-row-${row.reviewer_id}`}
                className="border-t border-[var(--border-subtle)]"
              >
                <td className="py-1.5 truncate max-w-[180px]">{row.email}</td>
                <td className="py-1.5 text-right">{row.total_reviewed}</td>
                <td className="py-1.5 text-right">{row.accepted}</td>
                <td className="py-1.5 text-right">{row.rejected}</td>
                <td className="py-1.5 text-right">
                  {(row.accept_rate * 100).toFixed(1)}%
                </td>
                <td className="py-1.5">
                  <Sparkline rate={row.accept_rate} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/** Static accept-rate bar — until per-day reviewer history is available
 *  the sparkline column shows the current rate as a relative fill. */
function Sparkline({ rate }: { rate: number }) {
  const pct = Math.max(0, Math.min(1, rate)) * 100;
  return (
    <div
      role="img"
      aria-label={`Accept rate ${pct.toFixed(0)}%`}
      className="h-2 rounded-full bg-[var(--bg-subtle)] overflow-hidden"
    >
      <div className="h-full bg-[var(--accent)]" style={{ width: `${pct}%` }} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Per-class precision (horizontal bar chart)
// ---------------------------------------------------------------------------
function PerClassPrecisionSection({
  projectId,
  taskId,
}: {
  projectId: string;
  taskId?: string;
}) {
  const tasksQ = useQuery({
    queryKey: ["tasks", projectId],
    queryFn: () => tasksApi.listForProject(projectId),
    enabled: !taskId,
  });
  const resolvedTaskId = taskId ?? tasksQ.data?.[0]?.id ?? null;

  const q = useQuery<PerClassQualityRow[]>({
    queryKey: ["quality/per-class", resolvedTaskId],
    queryFn: () => qualityApi.perClassQuality(resolvedTaskId as string),
    enabled: !!resolvedTaskId,
  });

  const rows = q.data ?? [];
  const data = rows.map((r) => ({
    name: r.name,
    color: r.color,
    accepted: r.accepted,
    rejected: r.rejected,
    proposed: r.proposed,
    precision:
      r.proxy_precision === null
        ? 0
        : Math.round(r.proxy_precision * 1000) / 10,
  }));

  return (
    <div className={cardClass} data-testid="quality-per-class-card">
      <h3 className={headingClass}>Per-class precision</h3>
      {!resolvedTaskId && (
        <p className="text-[12px] text-[color:var(--text-tertiary)]">
          No tasks yet.
        </p>
      )}
      {resolvedTaskId && q.isLoading && (
        <p className="text-[12px] text-[color:var(--text-tertiary)]">
          Loading…
        </p>
      )}
      {resolvedTaskId && rows.length > 0 && (
        <ResponsiveContainer
          width="100%"
          height={Math.max(160, rows.length * 28)}
        >
          <BarChart
            data={data}
            layout="vertical"
            margin={{ top: 4, right: 16, bottom: 4, left: 16 }}
          >
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis
              type="number"
              domain={[0, 100]}
              tick={{ fontSize: 10.5 }}
            />
            <YAxis
              type="category"
              dataKey="name"
              tick={{ fontSize: 10.5 }}
              width={110}
            />
            <Tooltip
              formatter={(
                value: number,
                _name: string,
                props: { payload?: (typeof data)[number] },
              ) => {
                const p = props.payload;
                if (!p) return [`${value}%`, "Precision"];
                return [
                  `${value}% (✓ ${p.accepted} / ✗ ${p.rejected}, proposed ${p.proposed})`,
                  "Precision",
                ];
              }}
            />
            <Bar dataKey="precision">
              {data.map((d) => (
                <Cell key={d.name} fill={d.color || "rgb(150, 200, 255)"} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Retrain history (line chart with mAP50 + mAP50-95)
// ---------------------------------------------------------------------------
function RetrainHistorySection({ projectId }: { projectId: string }) {
  const q = useQuery<RetrainRow[]>({
    queryKey: ["quality/retrain", projectId],
    queryFn: () => qualityApi.retrainHistory(projectId, 20),
  });

  const rows = q.data ?? [];
  const data = rows.map((r) => ({
    date: new Date(r.created_at).toLocaleDateString(),
    mAP50: r.metrics?.["mAP50"] ?? null,
    mAP50_95: r.metrics?.["mAP50-95"] ?? null,
  }));

  return (
    <div className={cardClass} data-testid="quality-retrain-card">
      <h3 className={headingClass}>Retrain history</h3>
      {q.isLoading && (
        <p className="text-[12px] text-[color:var(--text-tertiary)]">
          Loading…
        </p>
      )}
      {!q.isLoading && rows.length === 0 && (
        <p className="text-[12px] text-[color:var(--text-tertiary)]">
          No retrain runs yet.
        </p>
      )}
      {rows.length > 0 && (
        <ResponsiveContainer width="100%" height={200}>
          <LineChart
            data={data}
            margin={{ top: 8, right: 16, bottom: 8, left: 8 }}
          >
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="date" tick={{ fontSize: 10.5 }} />
            <YAxis domain={[0, 1]} tick={{ fontSize: 10.5 }} />
            <Tooltip />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            <Line
              type="monotone"
              dataKey="mAP50"
              stroke="rgb(120, 220, 160)"
              dot
              connectNulls
            />
            <Line
              type="monotone"
              dataKey="mAP50_95"
              name="mAP50-95"
              stroke="rgb(150, 200, 255)"
              dot
              connectNulls
            />
          </LineChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}
