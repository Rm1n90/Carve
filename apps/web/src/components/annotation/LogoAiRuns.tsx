// Armin Mehri — mehri.armin@gmail.com
/**
 * Logo AI — the "Runs" tab: recent runs for the task with live progress.
 *
 * Purely presentational. The parent owns the jobs query (and its
 * polling cadence) so the same data also drives the toolbar badge and
 * the completion toasts while the dialog is closed.
 */
import { useState } from "react";
import { AlertTriangle, CheckCircle2, Clock, Loader2, XCircle } from "lucide-react";

import {
  isLogoAiJobActive,
  type LogoAiJob,
  type LogoAiJobStatus,
} from "@/api/logoAi";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";
import { formatRelative } from "@/lib/relativeTime";

export function formatUsd(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  if (value === 0) return "$0";
  if (value >= 100) return `$${Math.round(value)}`;
  if (value >= 1) return `$${value.toFixed(2)}`;
  return `$${value.toFixed(3)}`;
}

const STATUS_LABEL: Record<LogoAiJobStatus, string> = {
  queued: "Queued",
  running: "Running",
  preparing: "Preparing images",
  submitted: "Waiting for provider",
  ingesting: "Writing results",
  canceling: "Canceling…",
  completed: "Completed",
  completed_with_errors: "Completed with errors",
  failed: "Failed",
  canceled: "Canceled",
};

function formatTokens(n: number | undefined): string {
  const v = n ?? 0;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 10_000) return `${Math.round(v / 1000)}k`;
  if (v >= 1000) return `${(v / 1000).toFixed(1)}k`;
  return String(v);
}

/** Where the money went: billed tokens by kind. Output (reasoning plus
 *  the answer) is priced several times higher than input. */
function usageLine(job: LogoAiJob): string | null {
  const u = job.usage;
  if (!u.output_tokens && !u.input_tokens) return null;
  const cached = u.cache_read_tokens ?? 0;
  const reasoning = u.reasoning_tokens ?? 0;
  return (
    `Tokens: ${formatTokens((u.input_tokens ?? 0) + (u.cache_write_tokens ?? 0))} in` +
    (cached > 0 ? ` + ${formatTokens(cached)} cached` : "") +
    ` · ${formatTokens(u.output_tokens)} out` +
    (reasoning > 0 ? ` (${formatTokens(reasoning)} reasoning)` : "")
  );
}

function duration(job: LogoAiJob): string | null {
  const start = job.started_at ?? job.created_at;
  if (!job.completed_at || !start) return null;
  const s = Math.round((Date.parse(job.completed_at) - Date.parse(start)) / 1000);
  if (!Number.isFinite(s) || s < 0) return null;
  if (s < 90) return `${s}s`;
  if (s < 5400) return `${Math.round(s / 60)} min`;
  return `${(s / 3600).toFixed(1)} h`;
}

const KIND_LABEL: Record<LogoAiJob["delivery"], string> = {
  single: "Single image",
  realtime: "Realtime",
  batch: "Batch",
};

/** One line saying where the run is, in the units of its current phase. */
function phaseDetail(job: LogoAiJob): string {
  switch (job.status) {
    case "queued":
      return `${job.total_assets} asset${job.total_assets === 1 ? "" : "s"} · waiting for the worker`;
    case "running":
      return `${job.done_assets}/${job.total_assets} assets`;
    case "preparing":
      return `${job.prepared_assets}/${job.total_assets} images prepared`;
    case "submitted":
      // Anthropic only reports per-request counts once a batch has
      // ended, so "0 answered" would read as stuck. Say what is known.
      return (
        (job.finished_requests > 0
          ? `${job.finished_requests}/${job.total_requests} requests answered`
          : `${job.total_requests} request${job.total_requests === 1 ? "" : "s"} with the provider`) +
        (job.expires_at ? ` · expires ${formatRelative(job.expires_at)}` : "")
      );
    case "ingesting":
      return `${job.done_assets}/${job.total_assets} assets written`;
    case "canceling":
      return job.delivery === "batch"
        ? "waiting for the provider to stop; finished results are kept"
        : "stopping after the current images";
    default:
      return `${job.done_assets}/${job.total_assets} assets`;
  }
}

function StatusIcon({ status }: { status: LogoAiJobStatus }) {
  if (status === "completed")
    return <CheckCircle2 className="h-4 w-4 text-[color:var(--success)]" aria-hidden />;
  if (status === "completed_with_errors")
    return <AlertTriangle className="h-4 w-4 text-[color:var(--warning)]" aria-hidden />;
  if (status === "failed")
    return <XCircle className="h-4 w-4 text-[color:var(--danger)]" aria-hidden />;
  if (status === "canceled")
    return <XCircle className="h-4 w-4 text-[color:var(--text-tertiary)]" aria-hidden />;
  if (status === "submitted" || status === "queued")
    return <Clock className="h-4 w-4 text-[color:var(--accent)]" aria-hidden />;
  return <Loader2 className="h-4 w-4 text-[color:var(--accent)] animate-spin" aria-hidden />;
}

function RunRow({
  job,
  modelLabel,
  onCancel,
}: {
  job: LogoAiJob;
  modelLabel: string;
  onCancel: (job: LogoAiJob) => Promise<void>;
}) {
  const [canceling, setCanceling] = useState(false);
  const active = isLogoAiJobActive(job);
  const took = duration(job);
  const tokens = usageLine(job);
  const pct = Math.round(Math.min(1, Math.max(0, job.progress)) * 100);
  const failedTone = job.status === "failed" || job.status === "canceled";
  // A run stuck in "canceling" can be closed out by asking again: a
  // realtime one because its worker never acknowledged, a batch (after
  // a confirmation) because the provider cannot be reached or read.
  const canCancel = active;

  return (
    <li
      data-testid={`logo-ai-run-${job.id}`}
      className="grid gap-2 p-3 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-elev)]"
    >
      <div className="flex items-start gap-2">
        <span className="mt-0.5 shrink-0">
          <StatusIcon status={job.status} />
        </span>
        <div className="grid gap-0.5 min-w-0 flex-1">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-[12.5px] font-medium truncate">
              {STATUS_LABEL[job.status]}
            </span>
            <span
              className={cn(
                "shrink-0 px-1.5 py-px rounded-[var(--radius-sm)] text-[10px] font-medium uppercase tracking-[0.4px]",
                job.delivery === "batch"
                  ? "bg-[var(--accent-bg)] text-[color:var(--accent)]"
                  : "bg-[var(--bg-subtle)] text-[color:var(--text-secondary)]",
              )}
            >
              {KIND_LABEL[job.delivery]}
            </span>
            <span className="ml-auto shrink-0 text-[10.5px] text-[color:var(--text-tertiary)]">
              {formatRelative(job.created_at)}
            </span>
          </div>
          <div className="text-[11px] text-[color:var(--text-secondary)] truncate">
            {job.label ? `${job.label} · ` : ""}
            {modelLabel}
            {job.effort ? ` · ${job.effort} effort` : ""}
            {took ? ` · took ${took}` : ""}
          </div>
        </div>
      </div>

      <div
        className="relative h-1.5 overflow-hidden rounded-full bg-[var(--bg-hover)]"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        aria-label="Run progress"
      >
        <div
          className={cn(
            "absolute inset-y-0 left-0 transition-[width] duration-300",
            failedTone ? "bg-[var(--danger)]" : "bg-[var(--accent)]",
          )}
          style={{ width: `${pct}%` }}
        />
      </div>

      <div className="flex items-center gap-3 text-[11px] text-[color:var(--text-secondary)]">
        <span className="font-mono tabular-nums truncate">{phaseDetail(job)}</span>
        <span className="ml-auto shrink-0 font-mono tabular-nums">
          {job.annotations_created} box{job.annotations_created === 1 ? "" : "es"}
          {(job.rejected_boxes ?? 0) > 0
            ? ` · ${job.rejected_boxes} rejected on the second look`
            : ""}
          {job.failed_assets > 0 ? ` · ${job.failed_assets} failed` : ""}
          {job.skipped_assets > 0 ? ` · ${job.skipped_assets} skipped` : ""}
        </span>
      </div>

      <div className="flex items-center gap-3 text-[11px] text-[color:var(--text-tertiary)]">
        <span title="Computed from the tokens billed so far">
          {active ? "Cost so far" : "Cost"} {formatUsd(job.cost_usd)}
          {job.estimated_cost_usd != null
            ? ` · estimated ${formatUsd(job.estimated_cost_usd)}`
            : ""}
        </span>
        {canCancel && (
          <Button
            variant="danger"
            size="sm"
            className="ml-auto"
            disabled={canceling}
            data-testid={`logo-ai-run-cancel-${job.id}`}
            onClick={async () => {
              setCanceling(true);
              try {
                await onCancel(job);
              } finally {
                setCanceling(false);
              }
            }}
          >
            {canceling
              ? "Canceling…"
              : job.status === "canceling"
                ? "Force stop"
                : "Cancel"}
          </Button>
        )}
      </div>

      {tokens && (
        <div className="text-[10.5px] font-mono tabular-nums text-[color:var(--text-tertiary)]">
          {tokens}
        </div>
      )}

      {active && job.notice && (
        <p
          data-testid={`logo-ai-run-notice-${job.id}`}
          className="text-[11px] text-[color:var(--warning)] break-words"
        >
          {job.notice}
          {job.resume_after && Date.parse(job.resume_after) > Date.now()
            ? ` Next try ${formatRelative(job.resume_after)}.`
            : ""}
        </p>
      )}
      {job.error && (
        <p className="text-[11px] text-[color:var(--danger)] break-words">{job.error}</p>
      )}
      {job.errors.length > 0 && (
        <details className="text-[11px] text-[color:var(--text-secondary)]">
          <summary className="cursor-pointer select-none">
            {/* The list also carries notes about things the run put
                right by itself, so it can be there with nothing failed. */}
            {job.failed_assets > 0
              ? `${job.failed_assets} failed asset${job.failed_assets === 1 ? "" : "s"}`
              : `${job.errors.length} note${job.errors.length === 1 ? "" : "s"}`}
            {job.failed_assets > 0 && job.errors.length < job.failed_assets
              ? ` (last ${job.errors.length} shown)`
              : ""}
          </summary>
          <ul className="mt-1 grid gap-0.5 max-h-[120px] overflow-y-auto font-mono text-[10.5px]">
            {job.errors.map((e, i) => (
              <li key={`${i}-${e}`} className="break-words">
                {e}
              </li>
            ))}
          </ul>
        </details>
      )}
    </li>
  );
}

export function LogoAiRuns({
  jobs,
  loading,
  modelLabel,
  onCancel,
}: {
  jobs: LogoAiJob[];
  loading: boolean;
  modelLabel: (job: LogoAiJob) => string;
  onCancel: (job: LogoAiJob) => Promise<void>;
}) {
  if (loading && jobs.length === 0) {
    return (
      <div className="flex items-center gap-2 p-4 text-[12px] text-[color:var(--text-secondary)]">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
        Loading runs…
      </div>
    );
  }
  if (jobs.length === 0) {
    return (
      <p className="p-4 text-[12px] text-[color:var(--text-secondary)]">
        No runs yet for this task. Runs over many assets show up here with
        their progress and cost, and keep going if you close this dialog.
      </p>
    );
  }
  return (
    <ul
      data-testid="logo-ai-runs"
      className="grid gap-2 max-h-[calc(88vh-300px)] min-h-[120px] overflow-y-auto pr-1"
    >
      {jobs.map((job) => (
        <RunRow
          key={job.id}
          job={job}
          modelLabel={modelLabel(job)}
          onCancel={onCancel}
        />
      ))}
    </ul>
  );
}
