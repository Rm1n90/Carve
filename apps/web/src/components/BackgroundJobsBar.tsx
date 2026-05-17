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
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, ChevronUp, Loader2, X, AlertTriangle } from "lucide-react";
import { samApi } from "@/api/sam";
import { inferenceApi } from "@/api/phase2";
import { yoloeApi } from "@/api/yoloe";
import { assetsApi } from "@/api/assets";
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

// Frontend-driven kinds (the runner is a Promise in this tab, not an
// RQ worker). The runner pushes progress directly into the store via
// ``setProgress``; the bar entry just reads it back from the store
// instead of issuing an HTTP poll.
const FRONTEND_KINDS: ReadonlySet<BackgroundJob["kind"]> = new Set([
  "polygon-convert",
  "sam-refine-batch",
]);

// Kinds that have a corresponding dialog/overlay we can re-open via
// expandRequest. Frontend-only kinds (polygon-convert, sam-refine-batch)
// don't have a dedicated expanded view — they were the post-process
// step inside another dialog. Hide the "Expand" button for those so
// the operator doesn't get a non-functional control.
const EXPANDABLE_KINDS: ReadonlySet<BackgroundJob["kind"]> = new Set([
  "sam-auto-text",
  "yolo-predict-batch",
  "yoloe-batch",
]);

function usePollJob(job: BackgroundJob): PollResult {
  const setProgress = useBackgroundJobs((s) => s.setProgress);
  const isFrontend = FRONTEND_KINDS.has(job.kind);

  const queryKey = useMemo(
    () => ["bg-job", job.kind, job.taskId, job.jobId] as const,
    [job.kind, job.taskId, job.jobId],
  );

  const queryFn = useMemo(() => {
    switch (job.kind) {
      case "sam-auto-text":
        return () => samApi.autoTextBatchProgress(job.taskId, job.jobId);
      case "sam-auto-visual":
        return () => samApi.autoVisualBatchProgress(job.taskId, job.jobId);
      case "yolo-predict-batch":
        return () => inferenceApi.pollBatchProgress(job.taskId, job.jobId);
      case "yoloe-batch":
        return () => yoloeApi.pollBatch(job.taskId, job.jobId);
      case "frame-extract":
        // v3.26 — assetId is required for frame-extract. The dialog
        // that registers the job always sets it; defensively skip the
        // poll if it's somehow missing.
        //
        // The frame-extract response shape differs from the batch-job
        // shape (decoded/expected vs done/total). Cast to the lenient
        // record so the queryFn's union return type stays compatible
        // across kinds; per-shape mapping happens in the setProgress
        // effect below.
        return job.assetId
          ? async () =>
              (await assetsApi.frameExtractStatus(
                job.assetId!,
              )) as unknown as Record<string, unknown>
          : async () => null;
      // Other kinds wire their own endpoint when they integrate.
      default:
        return async () => null;
    }
  }, [job.kind, job.taskId, job.jobId, job.assetId]);


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
  // For frontend-driven kinds, skip the HTTP-derived ``data`` and
  // read the progress the runner pushed to the store directly.
  const fePr = isFrontend ? job.progress : undefined;
  const isExtract = job.kind === "frame-extract";
  // v3.26 — frame-extract returns decoded/expected, not done/total.
  // Map to done/total so the existing pct math stays consistent and
  // also pass through phase/decoded/expected/uploaded for the bar
  // and useAssetExtractStatus to read.
  const status = (
    isFrontend
      ? ((fePr?.status as Status) ?? "running")
      : ((data?.status as string) ?? "unknown")
  ) as Status;
  const done = Number(
    (isFrontend ? fePr?.done : isExtract ? data?.decoded : data?.done) ?? 0,
  );
  const total = Number(
    (isFrontend ? fePr?.total : isExtract ? data?.expected : data?.total) ?? 0,
  );
  const failed = Number((isFrontend ? fePr?.failed : data?.failed) ?? 0);

  const qc = useQueryClient();

  // v3.32 -- track the last ``done`` we saw per job so we only fire
  // annotation invalidations when the worker has actually produced
  // something new since the previous poll. Without this we'd refetch
  // every 1.5s while the batch is just waiting on the GPU queue.
  const lastSeenDoneRef = useRef<number>(-1);

  useEffect(() => {
    if (isFrontend || !data) return;
    if (isExtract) {
      setProgress(job.jobId, {
        status,
        done,
        total,
        failed,
        phase: data.phase as BackgroundJobProgress["phase"],
        decoded: Number(data.decoded ?? 0),
        expected: Number(data.expected ?? 0),
        uploaded: Number(data.uploaded ?? 0),
        message:
          typeof data.message === "string" ? data.message : undefined,
      });
      // On terminal status, invalidate the asset-list and per-frame
      // queries so the asset card unlocks and the editor can open.
      if (status === "completed" || status === "failed") {
        qc.invalidateQueries({ queryKey: ["task-assets", job.taskId] });
        qc.invalidateQueries({ queryKey: ["task-assets-count", job.taskId] });
        if (job.assetId) {
          qc.invalidateQueries({ queryKey: ["frames", job.assetId] });
        }
      }
      return;
    }

    setProgress(job.jobId, { status, done, total, failed });

    // v3.32 -- annotation-producing batches (sam-auto-text,
    // sam-auto-visual, yolo-predict-batch, yoloe-batch) write new
    // annotations to the DB asset-by-asset. The open editor's
    // ``["annotations", taskId, frameId]`` cache stays stale until
    // something invalidates it. Previously only the dialog (while
    // open) invalidated; backgrounding the dialog left the editor
    // looking at a snapshot from before the batch started. Worse,
    // the asset the user was viewing when the batch ran showed
    // empty even after batch completion because the cache for that
    // exact (taskId, frameId) tuple was already populated and never
    // marked stale.
    //
    // Fix: invalidate on every progress poll where ``done`` grew,
    // plus once more on terminal status. The lastSeenDoneRef guard
    // keeps the network footprint reasonable -- one refetch per
    // asset processed, not per poll tick.
    const isAnnotationBatch =
      job.kind === "sam-auto-text" ||
      job.kind === "sam-auto-visual" ||
      job.kind === "yolo-predict-batch" ||
      job.kind === "yoloe-batch" ||
      job.kind === "sam-refine-batch";
    if (isAnnotationBatch) {
      const previous = lastSeenDoneRef.current;
      const isTerminalStatus =
        status === "completed" ||
        status === "completed_with_errors" ||
        status === "failed";
      if (done > previous || isTerminalStatus) {
        lastSeenDoneRef.current = done;
        qc.invalidateQueries({ queryKey: ["annotations", job.taskId] });
        qc.invalidateQueries({
          queryKey: ["task-annotations-raw", job.taskId],
        });
        qc.invalidateQueries({
          queryKey: ["task-annotations", job.taskId],
        });
        if (isTerminalStatus) {
          // Asset list / count may have changed (e.g. a new asset
          // gained its first annotation, badge needs updating).
          qc.invalidateQueries({ queryKey: ["task-assets", job.taskId] });
          qc.invalidateQueries({
            queryKey: ["task-assets-count", job.taskId],
          });
        }
      }
    }
  }, [
    isFrontend,
    isExtract,
    data,
    status,
    done,
    total,
    failed,
    setProgress,
    qc,
    job.jobId,
    job.taskId,
    job.assetId,
    job.kind,
  ]);

  return {
    status,
    done,
    total,
    failed,
    raw: (isFrontend ? fePr : (data as BackgroundJobProgress | undefined)),
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
            {EXPANDABLE_KINDS.has(job.kind) && (
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
            )}
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
