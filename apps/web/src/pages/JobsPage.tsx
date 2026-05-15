// Armin Mehri — mehri.armin@gmail.com
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, AlertTriangle, ArrowUp, X } from "lucide-react";

import { jobsApi, type JobRow } from "@/api/jobs";
import { Badge, Card } from "@/components/ui";
import { Button } from "@/components/ui/Button";
import { showToast } from "@/lib/toast";
import { SettingsLayout } from "@/pages/SettingsPages";

function ago(iso: string | null, now: number): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "—";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s ago`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m ago`;
}

const LANE_ORDER: Record<string, number> = { high: 0, default: 1, low: 2 };
const STATE_ORDER: Record<string, number> = {
  running: 0,
  queued: 1,
  failed: 2,
};

function stateVariant(s: string): "accent" | "neutral" | "danger" {
  if (s === "running") return "accent";
  if (s === "failed") return "danger";
  return "neutral";
}

function laneVariant(l: string): "warning" | "neutral" | "ghost" {
  if (l === "high") return "warning";
  if (l === "low") return "ghost";
  return "neutral";
}

export function JobsPage() {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: ["jobs"],
    queryFn: jobsApi.list,
    refetchInterval: 2000,
    refetchOnWindowFocus: false,
  });

  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const cancelMut = useMutation({
    mutationFn: (id: string) => jobsApi.cancel(id),
    onSuccess: () => {
      showToast("Cancel requested.", { variant: "warning", duration: 2500 });
      qc.invalidateQueries({ queryKey: ["jobs"] });
    },
    onError: () => showToast("Failed to cancel.", { variant: "error" }),
  });

  const reprioMut = useMutation({
    mutationFn: (id: string) => jobsApi.reprioritize(id),
    onSuccess: (r) => {
      const msg =
        r.result === "moved"
          ? "Bumped to the high lane — runs next."
          : r.result === "already"
            ? "Already on the high lane."
            : r.result === "not_queued"
              ? "Can't reprioritize — it's already running or finished."
              : "Reprioritize had no effect.";
      showToast(msg, {
        variant: r.result === "moved" ? "success" : "info",
        duration: 3000,
      });
      qc.invalidateQueries({ queryKey: ["jobs"] });
    },
    onError: () => showToast("Failed to reprioritize.", { variant: "error" }),
  });

  const status = (query.error as { response?: { status?: number } })?.response
    ?.status;
  const forbidden = status === 403;

  const jobs = useMemo(() => {
    const list = query.data?.jobs ?? [];
    return [...list].sort((a, b) => {
      const sd = (STATE_ORDER[a.state] ?? 9) - (STATE_ORDER[b.state] ?? 9);
      if (sd !== 0) return sd;
      const ld = (LANE_ORDER[a.lane] ?? 9) - (LANE_ORDER[b.lane] ?? 9);
      if (ld !== 0) return ld;
      return (a.enqueued_at ?? "").localeCompare(b.enqueued_at ?? "");
    });
  }, [query.data]);

  const counts = useMemo(() => {
    const c = { running: 0, queued: 0, failed: 0 };
    for (const j of jobs)
      if (j.state in c) c[j.state as keyof typeof c] += 1;
    return c;
  }, [jobs]);

  return (
    <SettingsLayout>
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-[16px] font-semibold tracking-tight">
            Background jobs
          </h2>
          <p className="text-[13px] text-[color:var(--text-secondary)] mt-1 max-w-[60ch]">
            The RQ queue across the high / default / low priority lanes.
            Cancel or stop a job, or bump a queued one to the high lane so
            the single worker runs it next.
          </p>
        </div>
        <div className="flex items-center gap-2 text-[11.5px] text-[color:var(--text-tertiary)]">
          <span
            className="h-1.5 w-1.5 rounded-full"
            style={{
              backgroundColor: query.isFetching
                ? "var(--accent)"
                : "var(--success)",
              transition: "background-color 200ms ease",
            }}
            aria-hidden
          />
          <Activity className="h-3.5 w-3.5" aria-hidden />
          <span className="tabular-nums">
            {query.data
              ? `${counts.running} running · ${counts.queued} queued · ${counts.failed} failed`
              : forbidden
                ? "Admins only"
                : query.isError
                  ? "Update failed"
                  : "Loading…"}
          </span>
        </div>
      </div>

      {forbidden ? (
        <Card
          variant="surface"
          radius="lg"
          className="p-8 grid gap-3 place-items-center text-center"
        >
          <AlertTriangle
            className="h-6 w-6 text-[color:var(--danger)]"
            aria-hidden
          />
          <h2 className="font-editorial text-[20px] text-[color:var(--text-primary)]">
            Admins only
          </h2>
          <p className="text-[12.5px] text-[color:var(--text-secondary)] max-w-[48ch]">
            The jobs queue spans every project — cancelling affects other
            users' work, so it's restricted to workspace admins.
          </p>
        </Card>
      ) : query.isError ? (
        <Card
          variant="surface"
          radius="lg"
          className="p-8 grid gap-3 place-items-center text-center"
        >
          <AlertTriangle
            className="h-6 w-6 text-[color:var(--danger)]"
            aria-hidden
          />
          <h2 className="font-editorial text-[20px] text-[color:var(--text-primary)]">
            Couldn't load the queue
          </h2>
          <p className="text-[12.5px] text-[color:var(--text-secondary)] max-w-[48ch]">
            {(query.error as Error)?.message ??
              "The API didn't respond. Check that the api + redis containers are healthy."}
          </p>
        </Card>
      ) : jobs.length === 0 ? (
        <Card
          variant="surface"
          radius="lg"
          className="p-10 grid place-items-center text-center"
        >
          <p className="text-[13px] text-[color:var(--text-secondary)]">
            The queue is empty — nothing running, queued, or recently
            failed.
          </p>
        </Card>
      ) : (
        <Card variant="surface" radius="lg" className="overflow-hidden">
          <div className="divide-y divide-[color:var(--border-subtle)]">
            {jobs.map((j) => (
              <JobRowView
                key={j.id}
                job={j}
                now={now}
                onCancel={() => cancelMut.mutate(j.id)}
                onReprioritize={() => reprioMut.mutate(j.id)}
                busy={
                  (cancelMut.isPending &&
                    cancelMut.variables === j.id) ||
                  (reprioMut.isPending && reprioMut.variables === j.id)
                }
              />
            ))}
          </div>
        </Card>
      )}
    </SettingsLayout>
  );
}

function JobRowView({
  job,
  now,
  onCancel,
  onReprioritize,
  busy,
}: {
  job: JobRow;
  now: number;
  onCancel: () => void;
  onReprioritize: () => void;
  busy: boolean;
}) {
  const isRunning = job.state === "running";
  const isQueued = job.state === "queued";
  const hasProgress =
    job.total != null && job.total > 0 && job.progress_status != null;
  const pct = hasProgress
    ? Math.min(100, Math.round(((job.done ?? 0) / (job.total ?? 1)) * 100))
    : 0;

  return (
    <div className="flex items-center gap-4 px-5 py-3.5">
      <div className="flex items-center gap-2 shrink-0 w-[150px]">
        <Badge variant={stateVariant(job.state)} size="md">
          {job.state}
        </Badge>
        <Badge variant={laneVariant(job.lane)} size="sm">
          {job.lane}
        </Badge>
      </div>

      <div className="grid gap-0.5 min-w-0 flex-1">
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-mono text-[12.5px] text-[color:var(--text-primary)] truncate">
            {job.func}
          </span>
          <span className="font-mono text-[10.5px] text-[color:var(--text-tertiary)] truncate">
            {job.id.slice(0, 8)}
          </span>
        </div>
        {job.description && (
          <span
            className="text-[11px] text-[color:var(--text-tertiary)] truncate"
            title={job.description}
          >
            {job.description}
          </span>
        )}
        {hasProgress && (
          <div className="flex items-center gap-2 mt-0.5">
            <div className="h-1 w-[140px] rounded-full bg-[var(--bg-sunken)] overflow-hidden">
              <div
                className="h-full bg-[var(--accent)]"
                style={{ width: `${pct}%` }}
              />
            </div>
            <span className="text-[10.5px] tabular-nums text-[color:var(--text-tertiary)]">
              {job.done}/{job.total} · {job.created} created
            </span>
          </div>
        )}
      </div>

      <span className="text-[11px] tabular-nums text-[color:var(--text-tertiary)] shrink-0 w-[110px] text-right">
        {isRunning ? ago(job.started_at, now) : ago(job.enqueued_at, now)}
      </span>

      <div className="flex items-center gap-2 shrink-0 w-[200px] justify-end">
        {isQueued && job.lane !== "high" && (
          <Button
            variant="secondary"
            size="sm"
            disabled={busy}
            leftIcon={<ArrowUp className="h-3.5 w-3.5" />}
            onClick={onReprioritize}
          >
            Reprioritize
          </Button>
        )}
        {(isQueued || isRunning) && (
          <Button
            variant="danger"
            size="sm"
            disabled={busy}
            leftIcon={<X className="h-3.5 w-3.5" />}
            onClick={() => {
              if (
                isRunning &&
                !window.confirm(
                  "Stop this running job? Work already committed per-asset is kept.",
                )
              )
                return;
              onCancel();
            }}
          >
            {isRunning ? "Stop" : "Cancel"}
          </Button>
        )}
      </div>
    </div>
  );
}
