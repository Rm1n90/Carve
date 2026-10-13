// Armin Mehri — mehri.armin@gmail.com
//
// Boxes -> polygons and masks for a whole task, run on the server. The
// dialog starts the run, then shows where it is: the image in work, how
// many are done and left, about how long it still takes, what it made
// so far, and the latest images drawn with their new shapes (click one
// to see it large; "Flagged" lists the images where SAM missed a box or
// was unsure, to look at first). Closing the dialog does not stop it.
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ExternalLink, Loader2, X } from "lucide-react";
import {
  ACTIVE_STATUSES,
  boxConvertApi,
  type BoxConvertImage,
  type BoxConvertJob,
} from "@/api/boxConvert";
import { Button } from "@/components/ui/Button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/Dialog";
import { cn } from "@/lib/cn";

const n = (v: number) => v.toLocaleString();

export function formatDuration(seconds: number): string {
  if (seconds < 60) return "under a minute";
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  if (h < 24) return rest ? `${h} h ${rest} min` : `${h} h`;
  const d = Math.floor(h / 24);
  return `${d} d ${h % 24} h`;
}

const STATUS_TEXT: Record<string, string> = {
  queued: "Waiting for a worker",
  running: "Converting",
  waiting_for_gpu: "Waiting for SAM (the model is busy or reloading)",
  completed: "Finished",
  completed_with_errors: "Finished, some images failed",
  failed: "Stopped by an error",
  canceled: "Stopped",
};

/** The server's reason for refusing, as words. */
function refusal(err: unknown): string {
  const d = (err as { response?: { data?: { error?: string; loaded?: string } } })?.response?.data;
  if (d?.error === "already_running") return "A conversion is already running on this task.";
  if (d?.error === "logo_ai_running") return "A Logo AI run is working on this task. Start this when it has finished.";
  if (d?.error === "wrong_sam_variant")
    return `SAM ${d.loaded ?? "(another variant)"} is loaded. This needs SAM 3.1: switch to it in the editor's SAM menu first.`;
  if (d?.error === "no_boxes") return "There are no boxes left to convert in this task.";
  return "Something went wrong; nothing was started.";
}

/** An image with its annotations drawn on it, fetched with the session's token. */
function Preview({
  taskId,
  assetId,
  width,
  version,
  className,
  alt,
}: {
  taskId: string;
  assetId: string;
  width: number;
  version: string;
  className?: string;
  alt: string;
}) {
  const q = useQuery({
    queryKey: ["box-convert-preview", taskId, assetId, width, version],
    queryFn: () => boxConvertApi.previewUrl(taskId, assetId, width),
    staleTime: Infinity,
    gcTime: 60_000,
  });
  const url = q.data;
  useEffect(
    () => () => {
      if (url) URL.revokeObjectURL?.(url);
    },
    [url],
  );
  if (!url)
    return (
      <div className={cn("grid place-items-center bg-[var(--bg-sunken,var(--bg-hover))]", className)}>
        {q.isError ? (
          <span className="text-[11px] text-tertiary">No preview</span>
        ) : (
          <Loader2 className="h-4 w-4 animate-spin text-tertiary" />
        )}
      </div>
    );
  return <img src={url} alt={alt} className={cn("object-contain bg-black", className)} />;
}

function ImageCounts({ e }: { e: BoxConvertImage }) {
  if (e.error) return <span className="text-[color:var(--danger)]">Failed: {e.error}</span>;
  const parts = [
    e.polygons ? `${e.polygons} polygon${e.polygons === 1 ? "" : "s"}` : "",
    e.masks ? `${e.masks} mask${e.masks === 1 ? "" : "s"}` : "",
    e.merged ? `${e.merged} crowd joined` : "",
    e.kept ? `${e.kept} left as box` : "",
    e.low_score ? `${e.low_score} unsure` : "",
  ].filter(Boolean);
  return <span>{parts.join(" · ") || "no boxes"}</span>;
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: "warn" | "danger" }) {
  return (
    <div className="grid gap-0.5 rounded-[var(--radius-sm)] border border-[var(--border-subtle)] px-2.5 py-1.5">
      <span
        className={cn(
          "font-mono-data text-[14px] tabular-nums text-primary",
          tone === "warn" && value > 0 && "text-[color:var(--warning,var(--accent))]",
          tone === "danger" && value > 0 && "text-[color:var(--danger)]",
        )}
      >
        {n(value)}
      </span>
      <span className="text-[11px] text-tertiary">{label}</span>
    </div>
  );
}

function editorHref(projectId: string, taskId: string, assetId: string) {
  return `/projects/${projectId}/tasks/${taskId}/assets/${assetId}`;
}

function Results({ projectId, taskId, job }: { projectId: string; taskId: string; job: BoxConvertJob }) {
  const [tab, setTab] = useState<"latest" | "flagged">("latest");
  const [big, setBig] = useState<BoxConvertImage | null>(null);
  const active = ACTIVE_STATUSES.has(job.status);
  const flaggedQ = useQuery({
    queryKey: ["box-convert-log", taskId, job.job_id, "flagged"],
    queryFn: () => boxConvertApi.log(taskId, job.job_id, { only: "flagged", limit: 24 }),
    enabled: tab === "flagged",
    refetchInterval: tab === "flagged" && active ? 15_000 : false,
  });
  const items = tab === "latest" ? job.recent.slice(0, 12) : (flaggedQ.data?.items ?? []);
  return (
    <div className="grid gap-2" data-testid="box-convert-results">
      <div className="flex items-center gap-1.5">
        {(["latest", "flagged"] as const).map((t) => (
          <button
            key={t}
            type="button"
            data-testid={`box-convert-tab-${t}`}
            onClick={() => setTab(t)}
            className={cn(
              "rounded-full px-2.5 py-1 text-[12px] border",
              tab === t
                ? "border-[var(--accent)] text-primary"
                : "border-[var(--border-subtle)] text-tertiary hover:text-secondary",
            )}
          >
            {t === "latest" ? "Latest images" : `To check${flaggedQ.data ? ` (${n(flaggedQ.data.total)})` : ""}`}
          </button>
        ))}
        <span className="ml-auto text-[11px] text-tertiary">
          {tab === "latest"
            ? "Click an image to see it large."
            : "A box SAM found nothing in (left as a box), was unsure of, or an image that failed."}
        </span>
      </div>
      {big && (
        <div className="relative grid gap-1.5" data-testid="box-convert-big">
          <Preview
            taskId={taskId}
            assetId={big.asset_id}
            width={1600}
            version={`${job.job_id}:${big.index}:big`}
            alt={big.name}
            className="max-h-[56vh] w-full rounded-[var(--radius-sm)]"
          />
          <div className="flex items-center gap-2 text-[12px] text-secondary">
            <span className="truncate font-medium text-primary">
              #{n(big.index)} {big.name}
            </span>
            <ImageCounts e={big} />
            <a
              href={editorHref(projectId, taskId, big.asset_id)}
              target="_blank"
              rel="noreferrer"
              className="ml-auto inline-flex items-center gap-1 text-[color:var(--accent)] hover:underline"
            >
              Open in editor <ExternalLink className="h-3 w-3" />
            </a>
            <button
              type="button"
              aria-label="Close large view"
              onClick={() => setBig(null)}
              className="grid h-6 w-6 place-items-center rounded-full text-tertiary hover:bg-[var(--bg-hover)] hover:text-primary"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      )}
      {items.length === 0 ? (
        <p className="py-3 text-center text-[12px] text-tertiary">
          {tab === "latest" ? "No image converted yet." : flaggedQ.isLoading ? "Loading…" : "Nothing to check so far."}
        </p>
      ) : (
        <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
          {items.map((e) => (
            <li key={`${e.index}-${e.asset_id}`}>
              <button
                type="button"
                data-testid="box-convert-image"
                onClick={() => setBig(e)}
                className={cn(
                  "grid w-full gap-1 rounded-[var(--radius-sm)] border p-1 text-left",
                  big?.asset_id === e.asset_id
                    ? "border-[var(--accent)]"
                    : "border-[var(--border-subtle)] hover:border-[var(--border-strong)]",
                )}
              >
                <Preview
                  taskId={taskId}
                  assetId={e.asset_id}
                  width={360}
                  version={`${job.job_id}:${e.index}`}
                  alt={e.name}
                  className="aspect-[4/3] w-full rounded-[calc(var(--radius-sm)-2px)]"
                />
                <span className="truncate text-[11px] text-secondary" title={e.name}>
                  #{n(e.index)} {e.name}
                </span>
                <span className="text-[10.5px] leading-tight text-tertiary">
                  <ImageCounts e={e} />
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function BoxConvertDialog({
  open,
  onOpenChange,
  projectId,
  taskId,
  taskName,
  onFinished,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  taskId: string;
  taskName?: string;
  /** A run ended while the dialog watched it (refresh what shows the task). */
  onFinished?: () => void;
}) {
  const qc = useQueryClient();
  const stateQ = useQuery({
    queryKey: ["box-convert", taskId],
    queryFn: () => boxConvertApi.get(taskId),
    enabled: open,
    refetchInterval: (q) => (q.state.data?.job && ACTIVE_STATUSES.has(q.state.data.job.status) ? 3000 : false),
  });
  const job = stateQ.data?.job ?? null;
  const left = stateQ.data?.left;
  const active = !!job && ACTIVE_STATUSES.has(job.status);

  const [wasActive, setWasActive] = useState(false);
  useEffect(() => {
    if (active) setWasActive(true);
    else if (wasActive) {
      setWasActive(false);
      onFinished?.();
    }
  }, [active, wasActive, onFinished]);

  const refresh = () => qc.invalidateQueries({ queryKey: ["box-convert", taskId] });
  const start = useMutation({ mutationFn: () => boxConvertApi.start(taskId), onSuccess: refresh });
  const stop = useMutation({ mutationFn: () => boxConvertApi.cancel(taskId, job!.job_id), onSuccess: refresh });
  const resume = useMutation({ mutationFn: () => boxConvertApi.resume(taskId, job!.job_id), onSuccess: refresh });

  const canResume = !!job && (job.status === "canceled" || job.status === "failed" || job.stalled) && job.done < job.total;
  const pct = job && job.total > 0 ? Math.min(100, (job.done / job.total) * 100) : 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(96vw,900px)]">
        <DialogHeader>
          <DialogTitle>Boxes to polygons and masks{taskName ? ` · ${taskName}` : ""}</DialogTitle>
          <DialogDescription>
            SAM 3.1 outlines the object in every box, image by image, on the server. Each class gets its own
            treatment: objects become polygons (masks when they have holes or several parts), boards keep their
            print, the ground and crowds become masks, touching crowd boxes are joined. A box SAM finds nothing in
            stays a box. Each image is saved as soon as it is done; closing this window does not stop it.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3" data-testid="box-convert-body">
          {stateQ.isLoading && <p className="text-[12.5px] text-tertiary">Loading…</p>}

          {job && (
            <div className="grid gap-2" data-testid="box-convert-progress">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[12.5px]">
                <span className="inline-flex items-center gap-1.5 font-medium text-primary" data-testid="box-convert-status">
                  {active && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  {job.stalled ? "No progress for 20 minutes" : (STATUS_TEXT[job.status] ?? job.status)}
                </span>
                <span className="font-mono-data tabular-nums text-secondary" data-testid="box-convert-count">
                  {n(job.done)} of {n(job.total)} images · {n(Math.max(0, job.total - job.done))} left
                </span>
                {active && job.eta_seconds != null && (
                  <span className="text-secondary" data-testid="box-convert-eta">
                    about {formatDuration(job.eta_seconds)} to go
                    {job.seconds_per_image != null && ` (${job.seconds_per_image.toFixed(1)} s per image)`}
                  </span>
                )}
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-[var(--bg-hover)]">
                <div
                  className="h-full rounded-full bg-[var(--accent)] transition-[width] duration-500"
                  style={{ width: `${pct}%` }}
                />
              </div>
              {active && job.current && (
                <p className="truncate text-[12px] text-secondary" data-testid="box-convert-current">
                  Now: <span className="text-primary">#{n(job.current.index)} {job.current.name}</span>
                </p>
              )}
              {job.error && (
                <p className="inline-flex items-center gap-1.5 text-[12px] text-[color:var(--danger)]">
                  <AlertTriangle className="h-3.5 w-3.5" /> {job.error}
                </p>
              )}
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-6" data-testid="box-convert-stats">
                <Stat label="boxes done" value={job.boxes - job.kept} />
                <Stat label="polygons" value={job.polygons} />
                <Stat label="masks" value={job.masks} />
                <Stat label="crowds joined" value={job.merged} />
                <Stat label="left as boxes" value={job.kept} tone="warn" />
                <Stat label="failed images" value={job.failed} tone="danger" />
              </div>
              {job.failed > 0 && job.errors.length > 0 && (
                <details className="text-[11.5px] text-tertiary">
                  <summary className="cursor-pointer">Why images failed (latest)</summary>
                  <ul className="mt-1 grid gap-0.5">
                    {job.errors.slice(-8).map((e, i) => (
                      <li key={i} className="truncate">{e}</li>
                    ))}
                  </ul>
                </details>
              )}
              <Results projectId={projectId} taskId={taskId} job={job} />
            </div>
          )}

          {!active && left && (
            <p className="text-[12.5px] text-secondary" data-testid="box-convert-left">
              {left.boxes > 0 ? (
                <>
                  <strong>{n(left.boxes)}</strong> box{left.boxes === 1 ? "" : "es"} on{" "}
                  <strong>{n(left.images)}</strong> image{left.images === 1 ? "" : "s"} still to convert
                  {job ? " (boxes SAM found nothing in are tried again)" : ""}.
                </>
              ) : (
                "No boxes left in this task: everything is a polygon or a mask."
              )}
            </p>
          )}
          {(start.isError || resume.isError) && (
            <p className="text-[12.5px] text-[color:var(--danger)]" data-testid="box-convert-refused">
              {refusal(start.error ?? resume.error)}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          {active && !job?.stalled && (
            <Button
              variant="danger"
              size="sm"
              data-testid="box-convert-stop"
              loading={stop.isPending}
              disabled={stop.isPending}
              onClick={() => stop.mutate()}
            >
              Stop after this image
            </Button>
          )}
          {canResume && (
            <Button
              variant="primary"
              size="sm"
              data-testid="box-convert-resume"
              loading={resume.isPending}
              disabled={resume.isPending}
              onClick={() => resume.mutate()}
            >
              Resume from #{n((job?.done ?? 0) + 1)}
            </Button>
          )}
          {!active && !canResume && (left?.boxes ?? 0) > 0 && (
            <Button
              variant="primary"
              size="sm"
              data-testid="box-convert-start"
              loading={start.isPending}
              disabled={start.isPending}
              onClick={() => start.mutate()}
            >
              Convert {n(left!.boxes)} box{left!.boxes === 1 ? "" : "es"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The task grid's way in: a button, or the run's progress while it goes. */
export function BoxConvertEntry({
  projectId,
  taskId,
  onFinished,
}: {
  projectId: string;
  taskId: string;
  onFinished?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const q = useQuery({
    queryKey: ["box-convert", taskId, "entry"],
    queryFn: () => boxConvertApi.get(taskId, 0),
    refetchInterval: (s) => (s.state.data?.job && ACTIVE_STATUSES.has(s.state.data.job.status) ? 10_000 : 60_000),
  });
  const job = q.data?.job ?? null;
  const active = !!job && ACTIVE_STATUSES.has(job.status);
  const boxes = q.data?.left?.boxes ?? 0;
  if (!active && boxes === 0 && !job) return null;
  return (
    <>
      <button
        type="button"
        data-testid="box-convert-entry"
        onClick={() => setOpen(true)}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[12px]",
          active
            ? "border-[var(--accent)] text-primary"
            : "border-[var(--border-subtle)] text-secondary hover:border-[var(--border-strong)] hover:text-primary",
        )}
      >
        {active ? (
          <>
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Converting boxes · {n(job!.done)} / {n(job!.total)}
            {job!.eta_seconds != null && <span className="text-tertiary">· {formatDuration(job!.eta_seconds)} left</span>}
          </>
        ) : boxes > 0 ? (
          <>Boxes → polygons… <span className="text-tertiary">{n(boxes)}</span></>
        ) : (
          <>Box conversion: {STATUS_TEXT[job!.status]?.toLowerCase() ?? job!.status}</>
        )}
      </button>
      <BoxConvertDialog
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (!o) void q.refetch();
        }}
        projectId={projectId}
        taskId={taskId}
        onFinished={onFinished}
      />
    </>
  );
}
