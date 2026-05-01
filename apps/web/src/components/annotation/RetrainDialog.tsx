import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Loader2, Sparkles, X } from "lucide-react";

import {
  weightsApi,
  type RetrainPhase,
  type RetrainStatus,
  type Weight,
} from "@/api/phase2";
import type { Task } from "@/api/tasks";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { showToast } from "@/lib/toast";
import { cn } from "@/lib/cn";

const IMG_SIZES: readonly number[] = [
  320, 416, 512, 640, 768, 896, 1024, 1280,
];
const POLL_INTERVAL_MS = 1500;

const TERMINAL_PHASES: ReadonlyArray<RetrainPhase> = [
  "done",
  "error",
  "canceled",
];

const RUNNING_PHASES: ReadonlyArray<RetrainPhase> = [
  "exporting",
  "uploading dataset",
  "training",
  "registering",
];

function describeApiError(err: unknown): string {
  const e = err as
    | {
        response?: { data?: { detail?: string; error?: string } };
        message?: string;
      }
    | undefined;
  return (
    e?.response?.data?.detail ??
    e?.response?.data?.error ??
    e?.message ??
    "Request failed"
  );
}

export interface RetrainDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  task: Pick<Task, "id" | "name"> | null;
  /** Project's available YOLO weights for the base-weight selector. */
  availableWeights: Weight[];
  /** Fired when the user accepts the freshly-trained weight. */
  onSuccess?: (weightId: string) => void;
}

/**
 * v3.4+ Phase 5 Task 6 — Retrain dialog. Submits a YOLO retrain job for
 * the selected task and polls the worker's progress hash every 1.5s
 * until a terminal phase is reached.
 */
export function RetrainDialog({
  open,
  onOpenChange,
  task,
  availableWeights,
  onSuccess,
}: RetrainDialogProps) {
  const [baseWeightId, setBaseWeightId] = useState<string>("");
  const [epochs, setEpochs] = useState<number>(30);
  const [imgsz, setImgsz] = useState<number>(640);
  const [includeProposed, setIncludeProposed] = useState<boolean>(false);
  const [weightName, setWeightName] = useState<string>("");
  const [jobId, setJobId] = useState<string | null>(null);

  // Reset form whenever the dialog reopens.
  useEffect(() => {
    if (open) {
      setBaseWeightId("");
      setEpochs(30);
      setImgsz(640);
      setIncludeProposed(false);
      setWeightName("");
      setJobId(null);
    }
  }, [open, task?.id]);

  const taskId = task?.id ?? "";

  const start = useMutation({
    mutationFn: async () => {
      if (!taskId) throw new Error("no_task");
      return weightsApi.retrainStart(taskId, {
        base_weight_id: baseWeightId || null,
        epochs,
        imgsz,
        include_proposed: includeProposed,
        weight_name: weightName.trim() || null,
      });
    },
    onSuccess: (r) => {
      setJobId(r.job_id);
    },
    onError: (err: unknown) => {
      showToast(describeApiError(err), { variant: "error", duration: 5000 });
    },
  });

  const statusQ = useQuery<RetrainStatus>({
    queryKey: ["retrain-yolo", taskId, jobId],
    queryFn: () => weightsApi.retrainStatus(taskId, jobId ?? ""),
    enabled: open && !!taskId && !!jobId,
    refetchInterval: (q) => {
      const p = q.state.data?.phase;
      if (p && (TERMINAL_PHASES as ReadonlyArray<string>).includes(p)) {
        return false;
      }
      return POLL_INTERVAL_MS;
    },
    refetchIntervalInBackground: false,
    staleTime: 0,
  });

  const cancel = useMutation({
    mutationFn: async () => {
      if (!taskId || !jobId) return;
      await weightsApi.retrainCancel(taskId, jobId);
    },
    onSuccess: () => {
      showToast("Retrain canceled.", { variant: "warning", duration: 2500 });
      setJobId(null);
      onOpenChange(false);
    },
    onError: (err: unknown) => {
      showToast(describeApiError(err), { variant: "error", duration: 5000 });
    },
  });

  const phase = statusQ.data?.phase ?? null;
  const isRunning =
    !!jobId &&
    !!phase &&
    (RUNNING_PHASES as ReadonlyArray<string>).includes(phase);
  const isPolling = !!jobId;

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        // While a job is mid-flight, don't let outside-clicks tear down
        // the dialog and orphan the polling query.
        if (!o && isRunning) return;
        onOpenChange(o);
      }}
    >
      <DialogContent className="w-[min(92vw,560px)]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-[color:var(--accent)]" />
            Retrain YOLO on this task
          </DialogTitle>
          <DialogDescription>
            {task
              ? `Train a new YOLO weight on the accepted annotations in “${task.name}”.`
              : "Pick a base weight and dataset options to start retraining."}
          </DialogDescription>
        </DialogHeader>

        {!isPolling ? (
          <RetrainForm
            availableWeights={availableWeights}
            baseWeightId={baseWeightId}
            setBaseWeightId={setBaseWeightId}
            epochs={epochs}
            setEpochs={setEpochs}
            imgsz={imgsz}
            setImgsz={setImgsz}
            includeProposed={includeProposed}
            setIncludeProposed={setIncludeProposed}
            weightName={weightName}
            setWeightName={setWeightName}
          />
        ) : (
          <RetrainProgress
            status={statusQ.data ?? null}
            onUseWeight={(wid) => {
              onSuccess?.(wid);
              setJobId(null);
              onOpenChange(false);
            }}
          />
        )}

        <DialogFooter>
          {!isPolling && (
            <>
              <Button
                variant="ghost"
                size="md"
                onClick={() => onOpenChange(false)}
                data-testid="retrain-dialog-cancel"
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                size="md"
                disabled={!task || start.isPending}
                loading={start.isPending}
                onClick={() => start.mutate()}
                data-testid="retrain-dialog-start"
              >
                Start retraining
              </Button>
            </>
          )}
          {isPolling && isRunning && (
            <Button
              variant="danger"
              size="md"
              disabled={cancel.isPending}
              loading={cancel.isPending}
              leftIcon={<X className="h-3.5 w-3.5" />}
              onClick={() => cancel.mutate()}
              data-testid="retrain-dialog-cancel-job"
            >
              Cancel training
            </Button>
          )}
          {isPolling && !isRunning && (
            <Button
              variant="ghost"
              size="md"
              onClick={() => {
                setJobId(null);
                onOpenChange(false);
              }}
              data-testid="retrain-dialog-close"
            >
              Close
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Form view
// ---------------------------------------------------------------------------

interface RetrainFormProps {
  availableWeights: Weight[];
  baseWeightId: string;
  setBaseWeightId: (v: string) => void;
  epochs: number;
  setEpochs: (v: number) => void;
  imgsz: number;
  setImgsz: (v: number) => void;
  includeProposed: boolean;
  setIncludeProposed: (v: boolean) => void;
  weightName: string;
  setWeightName: (v: string) => void;
}

function RetrainForm({
  availableWeights,
  baseWeightId,
  setBaseWeightId,
  epochs,
  setEpochs,
  imgsz,
  setImgsz,
  includeProposed,
  setIncludeProposed,
  weightName,
  setWeightName,
}: RetrainFormProps) {
  return (
    <div className="grid gap-4">
      {/* Base weight */}
      <label className="grid gap-1.5">
        <span className="text-[11px] uppercase tracking-[0.16em] text-[color:var(--text-tertiary)]">
          Base weight
        </span>
        <select
          data-testid="retrain-base-weight"
          value={baseWeightId}
          onChange={(e) => setBaseWeightId(e.target.value)}
          className="h-9 px-2 rounded-[var(--radius-sm)] border border-[var(--border-subtle)] bg-[var(--bg-app)] text-[12.5px] text-[color:var(--text-primary)]"
        >
          <option value="">(none — start from yolov8n.pt)</option>
          {availableWeights.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name} ({w.task_kind})
            </option>
          ))}
        </select>
      </label>

      {/* Epochs */}
      <label className="grid gap-1.5">
        <span className="text-[11px] uppercase tracking-[0.16em] text-[color:var(--text-tertiary)]">
          Epochs
        </span>
        <input
          data-testid="retrain-epochs"
          type="number"
          min={1}
          max={200}
          step={1}
          value={epochs}
          onChange={(e) => {
            const n = parseInt(e.target.value, 10);
            if (Number.isFinite(n)) setEpochs(Math.max(1, Math.min(200, n)));
          }}
          className="h-9 px-2 rounded-[var(--radius-sm)] border border-[var(--border-subtle)] bg-[var(--bg-app)] text-[12.5px] text-[color:var(--text-primary)]"
        />
      </label>

      {/* Image size */}
      <label className="grid gap-1.5">
        <span className="text-[11px] uppercase tracking-[0.16em] text-[color:var(--text-tertiary)]">
          Image size
        </span>
        <select
          data-testid="retrain-imgsz"
          value={imgsz}
          onChange={(e) => setImgsz(parseInt(e.target.value, 10))}
          className="h-9 px-2 rounded-[var(--radius-sm)] border border-[var(--border-subtle)] bg-[var(--bg-app)] text-[12.5px] text-[color:var(--text-primary)]"
        >
          {IMG_SIZES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </label>

      {/* Include proposed */}
      <label className="flex items-center gap-2 text-[12.5px] text-[color:var(--text-primary)] cursor-pointer">
        <input
          data-testid="retrain-include-proposed"
          type="checkbox"
          checked={includeProposed}
          onChange={(e) => setIncludeProposed(e.target.checked)}
        />
        Include proposed annotations (default: accepted only)
      </label>

      {/* Weight name */}
      <label className="grid gap-1.5">
        <span className="text-[11px] uppercase tracking-[0.16em] text-[color:var(--text-tertiary)]">
          New weight name <span className="opacity-60">(optional)</span>
        </span>
        <input
          data-testid="retrain-weight-name"
          type="text"
          placeholder="Leave blank for an auto-generated name"
          value={weightName}
          onChange={(e) => setWeightName(e.target.value)}
          className="h-9 px-2 rounded-[var(--radius-sm)] border border-[var(--border-subtle)] bg-[var(--bg-app)] text-[12.5px] text-[color:var(--text-primary)]"
        />
      </label>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Progress view
// ---------------------------------------------------------------------------

function phaseLabel(p: RetrainPhase | null): string {
  if (!p) return "Starting…";
  return p.charAt(0).toUpperCase() + p.slice(1);
}

function phaseBadgeClass(p: RetrainPhase | null): string {
  switch (p) {
    case "done":
      return "bg-[oklch(0.85_0.12_145_/0.25)] text-[oklch(0.45_0.16_145)]";
    case "error":
      return "bg-[oklch(0.85_0.16_25_/0.25)] text-[oklch(0.5_0.2_25)]";
    case "canceled":
      return "bg-[var(--bg-subtle)] text-[color:var(--text-secondary)]";
    default:
      return "bg-[var(--accent-bg)] text-[color:var(--accent)]";
  }
}

function RetrainProgress({
  status,
  onUseWeight,
}: {
  status: RetrainStatus | null;
  onUseWeight: (weightId: string) => void;
}) {
  const phase = status?.phase ?? null;
  const pct = Math.max(0, Math.min(100, status?.progress_pct ?? 0));
  const isDone = phase === "done";
  const isError = phase === "error";
  const isCanceled = phase === "canceled";

  return (
    <div data-testid="retrain-progress" className="grid gap-3">
      <div className="flex items-center gap-2">
        {!isDone && !isError && !isCanceled && (
          <Loader2 className="h-4 w-4 animate-spin text-[color:var(--accent)]" />
        )}
        <span
          data-testid="retrain-phase"
          className={cn(
            "inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium",
            phaseBadgeClass(phase),
          )}
        >
          {phaseLabel(phase)}
        </span>
        <span
          data-testid="retrain-progress-pct"
          className="font-mono text-[12px] text-[color:var(--text-tertiary)]"
        >
          {pct}%
        </span>
      </div>

      <div className="h-2 rounded-full bg-[var(--bg-sunken)] overflow-hidden">
        <div
          data-testid="retrain-progress-bar"
          className="h-full bg-[var(--accent)] transition-[width] duration-300"
          style={{ width: `${pct}%` }}
        />
      </div>

      {isDone && status?.weight_id && (
        <div
          data-testid="retrain-success"
          className="grid gap-2 rounded-[var(--radius-sm)] border border-[var(--border-subtle)] bg-[var(--bg-app)] p-3"
        >
          <p className="text-[12.5px] text-[color:var(--text-primary)]">
            Created weight{" "}
            <span className="font-mono text-[12px]">{status.weight_id}</span>.
            Use it?
          </p>
          <div className="flex justify-end">
            <Button
              variant="primary"
              size="sm"
              onClick={() => onUseWeight(status.weight_id ?? "")}
              data-testid="retrain-use-weight"
            >
              Use it
            </Button>
          </div>
        </div>
      )}

      {isError && (
        <div
          data-testid="retrain-error"
          className="grid gap-2 rounded-[var(--radius-sm)] border border-[var(--danger)] bg-[var(--danger-bg)] p-3"
        >
          <p className="text-[12.5px] text-[color:var(--danger)]">
            {status?.error ?? "Retraining failed."}
          </p>
          {status?.error_traceback && (
            <details className="text-[11.5px] text-[color:var(--text-tertiary)]">
              <summary className="cursor-pointer select-none">
                Traceback
              </summary>
              <pre className="mt-2 max-h-[160px] overflow-auto whitespace-pre-wrap font-mono text-[10.5px]">
                {status.error_traceback}
              </pre>
            </details>
          )}
        </div>
      )}

      {isCanceled && (
        <p
          data-testid="retrain-canceled"
          className="text-[12px] text-[color:var(--text-secondary)] italic"
        >
          Retraining canceled.
        </p>
      )}
    </div>
  );
}
