// Armin Mehri — mehri.armin@gmail.com
/**
 * Floating bar — shows the live progress of every backgrounded job
 * registered in ``useBackgroundJobs``. Mounted globally in AppShell,
 * pinned bottom-right so it doesn't fight task page chrome.
 *
 * Per-job entry contract:
 *  - Each entry runs its own React-Query poll (kind-aware endpoint).
 *  - On terminal status the entry shows a brief result, then
 *    auto-removes after 4 s.
 *  - "Expand" sets ``expandRequest`` so the original dialog re-opens
 *    in progress mode without re-prompting for config.
 *  - "Cancel" calls the per-job ``cancel`` closure registered by the
 *    dialog and removes the entry on success.
 */
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, ChevronUp, Loader2, X, AlertTriangle } from "lucide-react";
import { samApi } from "@/api/sam";
import { inferenceApi } from "@/api/phase2";
import { showToast } from "@/lib/toast";
import {
  useBackgroundJobs,
  type BackgroundJob,
  type BackgroundJobProgress,
} from "@/state/backgroundJobs";

const POLL_MS = 800;

type Status =
  | "running"
  | "completed"
  | "completed_with_errors"
  | "failed"
  | "canceled"
  | "unknown";

function isTerminal(status: string | undefined): boolean {
  return (
    status === "completed" ||
    status === "completed_with_errors" ||
    status === "failed" ||
    status === "canceled"
  );
}

interface PollResult {
  status: Status;
  done: number;
  total: number;
  failed: number;
  raw?: BackgroundJobProgress;
}

function usePollJob(job: BackgroundJob): PollResult {
  const setProgress = useBackgroundJobs((s) => s.setProgress);

  const queryKey = useMemo(
    () => ["bg-job", job.kind, job.taskId, job.jobId] as const,
    [job.kind, job.taskId, job.jobId],
  );

  const queryFn = useMemo(() => {
    switch (job.kind) {
      case "sam-auto-text":
        return () => samApi.autoTextBatchProgress(job.taskId, job.jobId);
      case "yolo-predict-batch":
        return () => inferenceApi.pollBatchProgress(job.taskId, job.jobId);
      // Other kinds wire their own endpoint when they integrate.
      default:
        return async () => null;
    }
  }, [job.kind, job.taskId, job.jobId]);

  const q = useQuery({
    queryKey,
    queryFn,
    refetchInterval: (qq) => {
      const s = (qq.state.data as { status?: string } | null)?.status;
      return isTerminal(s) ? false : POLL_MS;
    },
    refetchIntervalInBackground: true,
    staleTime: 0,
  });

  const data = q.data as Record<string, unknown> | null | undefined;
  const status = ((data?.status as string) ?? "unknown") as Status;
  const done = Number(data?.done ?? 0);
  const total = Number(data?.total ?? 0);
  const failed = Number(data?.failed ?? 0);

  useEffect(() => {
    if (data) {
      setProgress(job.jobId, { status, done, total, failed });
    }
  }, [data, status, done, total, failed, setProgress, job.jobId]);

  return {
    status,
    done,
    total,
    failed,
    raw: data as BackgroundJobProgress | undefined,
  };
}

interface JobEntryProps {
  job: BackgroundJob;
}

function JobEntry({ job }: JobEntryProps) {
  const requestExpand = useBackgroundJobs((s) => s.requestExpand);
  const remove = useBackgroundJobs((s) => s.remove);

  const poll = usePollJob(job);
  const [autoRemoveScheduled, setAutoRemoveScheduled] = useState(false);
  const [canceling, setCanceling] = useState(false);

  // Auto-remove from the bar 4 s after a terminal status.
  useEffect(() => {
    if (isTerminal(poll.status) && !autoRemoveScheduled) {
      setAutoRemoveScheduled(true);
      const id = window.setTimeout(() => remove(job.jobId), 4000);
      return () => window.clearTimeout(id);
    }
    return undefined;
  }, [poll.status, autoRemoveScheduled, remove, job.jobId]);

  const pct =
    poll.total > 0 ? Math.min(100, Math.round((poll.done / poll.total) * 100)) : 0;

  const isRunning = poll.status === "running" || poll.status === "unknown";
  const isFail = poll.status === "failed";
  const isCanceled = poll.status === "canceled";
  const isDoneOk =
    poll.status === "completed" || poll.status === "completed_with_errors";

  const StatusIcon = isRunning
    ? Loader2
    : isFail || isCanceled
      ? AlertTriangle
      : CheckCircle2;

  const accent = isFail
    ? "var(--danger, #d4504a)"
    : isCanceled
      ? "var(--text-tertiary)"
      : "var(--accent)";

  return (
    <div
      data-testid={`bg-job-entry-${job.jobId}`}
      className="grid gap-2 p-3 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-elev)] shadow-lg backdrop-blur-md min-w-[280px] max-w-[360px]"
    >
      <div className="flex items-start gap-2">
        <StatusIcon
          className={`h-4 w-4 shrink-0 mt-0.5 ${isRunning ? "animate-spin" : ""}`}
          style={{ color: accent }}
          aria-hidden
        />
        <div className="grid gap-0.5 min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[12.5px] font-medium text-[color:var(--text-primary)] truncate">
              {job.label}
            </span>
            <span className="text-[10.5px] tabular-nums text-[color:var(--text-tertiary)] shrink-0">
              {isRunning && poll.total > 0
                ? `${poll.done}/${poll.total}`
                : isDoneOk
                  ? "Done"
                  : isCanceled
                    ? "Canceled"
                    : isFail
                      ? "Failed"
                      : ""}
            </span>
          </div>
          <div
            className="h-1.5 rounded-full bg-[var(--bg-sunken)] overflow-hidden"
            aria-label={`${job.label} progress`}
          >
            <div
              className="h-full transition-[width] duration-300"
              style={{
                width: `${isDoneOk ? 100 : pct}%`,
                backgroundColor: accent,
              }}
            />
          </div>
          {poll.failed > 0 && isRunning && (
            <span className="text-[10px] text-[color:var(--warning,oklch(0.78_0.18_85))]">
              {poll.failed} skipped
            </span>
          )}
        </div>
      </div>
      <div className="flex items-center justify-end gap-1.5">
        {isRunning && (
          <>
            <button
              type="button"
              data-testid={`bg-job-cancel-${job.jobId}`}
              onClick={async () => {
                setCanceling(true);
                try {
                  await job.cancel();
                  showToast("Cancellation requested.", {
                    variant: "warning",
                  });
                } catch {
                  showToast("Cancel failed", { variant: "error" });
                } finally {
                  setCanceling(false);
                }
              }}
              disabled={canceling}
              title="Cancel job"
              className="inline-flex items-center gap-1 px-2 py-1 rounded-[var(--radius-sm)] text-[11px] text-[color:var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[color:var(--danger,#d4504a)] disabled:opacity-50"
            >
              <X className="h-3 w-3" aria-hidden />
              Cancel
            </button>
            <button
              type="button"
              data-testid={`bg-job-expand-${job.jobId}`}
              onClick={() => requestExpand(job.jobId)}
              title="Expand to dialog"
              className="inline-flex items-center gap-1 px-2 py-1 rounded-[var(--radius-sm)] text-[11px] font-medium text-[color:var(--text-primary)] hover:bg-[var(--bg-hover)]"
            >
              <ChevronUp className="h-3 w-3" aria-hidden />
              Expand
            </button>
          </>
        )}
        {!isRunning && (
          <button
            type="button"
            onClick={() => remove(job.jobId)}
            title="Dismiss"
            className="inline-flex items-center gap-1 px-2 py-1 rounded-[var(--radius-sm)] text-[11px] text-[color:var(--text-secondary)] hover:bg-[var(--bg-hover)]"
          >
            <X className="h-3 w-3" aria-hidden />
            Dismiss
          </button>
        )}
      </div>
    </div>
  );
}

export function BackgroundJobsBar() {
  const jobs = useBackgroundJobs((s) => s.jobs);
  const entries = Object.values(jobs);
  if (entries.length === 0) return null;

  return (
    <div
      className="fixed bottom-4 right-4 z-[60] flex flex-col gap-2 pointer-events-auto"
      data-testid="background-jobs-bar"
    >
      {entries.map((job) => (
        <JobEntry key={job.jobId} job={job} />
      ))}
    </div>
  );
}
