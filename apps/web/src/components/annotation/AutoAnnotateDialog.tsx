import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Sparkles, X } from "lucide-react";

import { samApi } from "@/api/sam";
import type { ClassRow } from "@/api/classes";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { showToast } from "@/lib/toast";
import { cn } from "@/lib/cn";

interface AutoAnnotateDialogProps {
  /** The asset currently open in the editor (sync run scope). */
  assetId: string | null;
  /** v3.8 Phase 3.5 — task id for the multi-asset RQ batch path.
   *  When omitted, only "this image" scope is enabled. */
  taskId?: string;
  /** All classes in this project. Used to render the checklist. */
  classes: ClassRow[];
  /** Optional render override for the trigger button. Defaults to a
   *  small toolbar-style button with a sparkles icon. */
  trigger?: React.ReactNode;
  /** Optional callback fired after a successful run so the parent can
   *  refetch its annotation list. */
  onSuccess?: (createdCount: number) => void;
}

/**
 * v3.8 Phase 3.5 -- Auto-annotate dialog.
 *
 * Single panel covering the four canonical user intents:
 *   A. Single class, best match    -> uncheck others, Find=Best
 *   B. Single class, all instances -> uncheck others, Find=All
 *   C. Multi-class, this image     -> check several, Scope=This
 *   D. Multi-class, all assets     -> check several, Scope=All  (Phase 3.6 RQ batch)
 *
 * Phase 3.5 implements sync single-asset only. The "All assets" radio
 * is rendered disabled with a "Coming in Phase 3.6" hint so the user
 * sees the future direction without waiting on the RQ wiring.
 */
export function AutoAnnotateDialog({
  assetId,
  taskId,
  classes,
  trigger,
  onSuccess,
}: AutoAnnotateDialogProps) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [selectedClassIds, setSelectedClassIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [threshold, setThreshold] = useState<number>(0.4);
  const [findAll, setFindAll] = useState<boolean>(true);
  const [overwrite, setOverwrite] = useState<boolean>(false);
  // Phase 3.5: only "this" is wired. "all" reserved for Phase 3.6 (RQ batch).
  const [scope, setScope] = useState<"this" | "all">("this");
  // v3.8 Phase 3.5 — track an in-flight RQ batch so the dialog can
  // render a live progress overlay with Cancel.
  const [runningJobId, setRunningJobId] = useState<string | null>(null);

  const eligibleClasses = useMemo(
    () => classes.filter((c) => (c.text_prompt ?? "").trim().length > 0),
    [classes],
  );
  const ineligibleClasses = useMemo(
    () => classes.filter((c) => !(c.text_prompt ?? "").trim()),
    [classes],
  );

  const run = useMutation({
    mutationFn: async () => {
      // v3.8 Phase 3.5 — branch on scope. "this" is sync; "all" enqueues
      // an RQ batch and we return a pseudo-result the onSuccess can
      // recognise by the presence of a `job_id` field.
      if (scope === "all") {
        if (!taskId) throw new Error("no_task");
        const r = await samApi.autoTextBatch(taskId, {
          class_ids: Array.from(selectedClassIds),
          threshold,
          find_all: findAll,
          overwrite,
        });
        return { kind: "batch", job_id: r.job_id } as const;
      }
      if (!assetId) throw new Error("no_asset");
      const r = await samApi.autoText(assetId, {
        class_ids: Array.from(selectedClassIds),
        threshold,
        find_all: findAll,
        overwrite,
      });
      return { kind: "sync", ...r } as const;
    },
    onSuccess: (result) => {
      if (result.kind === "batch") {
        // Keep the dialog open and pivot to the live progress overlay.
        // The user can Cancel from there; per-asset commits mean any
        // already-saved annotations survive a cancel.
        setRunningJobId(result.job_id);
        return;
      }
      qc.invalidateQueries({ queryKey: ["annotations"] });
      showToast(
        result.annotations_created > 0
          ? `Created ${result.annotations_created} annotation${result.annotations_created === 1 ? "" : "s"}.`
          : "No matches above the threshold.",
        { variant: result.annotations_created > 0 ? "success" : "warning" },
      );
      onSuccess?.(result.annotations_created);
      setOpen(false);
    },
    onError: (err: unknown) => {
      const detail =
        (err as { response?: { data?: { error?: string; detail?: string } } })
          ?.response?.data?.error ??
        (err as { response?: { data?: { detail?: string } } })?.response?.data
          ?.detail;
      let message = "Auto-annotate failed.";
      if (detail === "sam3_not_enabled") {
        message = "Auto-annotate needs SAM 3. Switch in Settings -> Models.";
      } else if (detail === "model_service_unreachable") {
        message = "Model service is offline.";
      } else if (detail === "no_eligible_classes") {
        message = "Selected classes have no text prompt.";
      }
      showToast(message, { variant: "error", duration: 5000 });
    },
  });

  const toggleClass = (id: string) => {
    setSelectedClassIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const selectAll = () =>
    setSelectedClassIds(new Set(eligibleClasses.map((c) => c.id)));
  const selectNone = () => setSelectedClassIds(new Set());

  const canRun =
    selectedClassIds.size > 0 &&
    !run.isPending &&
    ((scope === "this" && !!assetId) ||
      (scope === "all" && !!taskId));

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {trigger ?? (
          <button
            type="button"
            data-testid="auto-annotate-trigger"
            disabled={!assetId}
            className={cn(
              "inline-flex items-center gap-1.5 h-8 px-3",
              "rounded-[var(--radius-sm)] border border-[var(--border-subtle)]",
              "text-[12.5px] tracking-tight text-[color:var(--text-secondary)]",
              "hover:bg-[var(--bg-hover)] hover:text-[color:var(--text-primary)]",
              "disabled:opacity-40 disabled:cursor-not-allowed",
              "transition-colors",
            )}
            title="Auto-annotate with SAM 3 text prompts"
          >
            <Sparkles className="h-3.5 w-3.5" />
            Auto-annotate
          </button>
        )}
      </DialogTrigger>
      <DialogContent className="w-[min(92vw,600px)]">
        {runningJobId && taskId ? (
          <BatchProgressView
            taskId={taskId}
            jobId={runningJobId}
            onDone={(final) => {
              const created = final?.total_annotations_created ?? 0;
              if (final?.status === "canceled") {
                showToast(
                  `Auto-annotate canceled. Kept ${created} annotation${created === 1 ? "" : "s"} created so far.`,
                  { variant: "warning", duration: 4500 },
                );
              } else if (final?.status === "completed_with_errors") {
                showToast(
                  `Auto-annotate finished with errors. Created ${created} annotations; ${final.failed} asset${final.failed === 1 ? "" : "s"} failed.`,
                  { variant: "warning", duration: 5000 },
                );
              } else {
                showToast(
                  created > 0
                    ? `Created ${created} annotation${created === 1 ? "" : "s"} across the task.`
                    : "Batch completed with no matches above the threshold.",
                  {
                    variant: created > 0 ? "success" : "warning",
                    duration: 4500,
                  },
                );
              }
              qc.invalidateQueries({ queryKey: ["annotations"] });
              onSuccess?.(created);
              setRunningJobId(null);
              setOpen(false);
            }}
          />
        ) : (
          <>
        <DialogHeader>
          <DialogTitle>Auto-annotate</DialogTitle>
          <DialogDescription>
            Run SAM 3 text prompts on the selected classes. Set per-class
            prompts in the Classes editor.
          </DialogDescription>
        </DialogHeader>

        {/* Engine */}
        <div className="grid gap-2 mb-4">
          <div className="text-[11px] uppercase tracking-[0.16em] text-[color:var(--text-tertiary)]">
            Engine
          </div>
          <div className="text-[13px] text-[color:var(--text-primary)]">
            SAM 3 Text
          </div>
        </div>

        {/* Class checklist */}
        <div className="grid gap-2 mb-4">
          <div className="flex items-center justify-between">
            <div className="text-[11px] uppercase tracking-[0.16em] text-[color:var(--text-tertiary)]">
              Classes
            </div>
            <div className="flex gap-1">
              <button
                type="button"
                onClick={selectAll}
                disabled={eligibleClasses.length === 0}
                className="h-6 px-2 rounded-[var(--radius-xs)] text-[11px] text-[color:var(--text-secondary)] hover:bg-[var(--bg-hover)] disabled:opacity-40"
              >
                Select all
              </button>
              <button
                type="button"
                onClick={selectNone}
                className="h-6 px-2 rounded-[var(--radius-xs)] text-[11px] text-[color:var(--text-secondary)] hover:bg-[var(--bg-hover)]"
              >
                None
              </button>
            </div>
          </div>
          <div className="max-h-[220px] overflow-y-auto grid gap-0.5 rounded-[var(--radius-sm)] border border-[var(--border-subtle)] bg-[var(--bg-app)] p-1">
            {eligibleClasses.map((c) => {
              const checked = selectedClassIds.has(c.id);
              return (
                <label
                  key={c.id}
                  data-testid={`auto-annotate-class-${c.id}`}
                  className={cn(
                    "flex items-center gap-2 px-2 py-1.5 rounded-[var(--radius-xs)] cursor-pointer",
                    "hover:bg-[var(--bg-hover)] transition-colors",
                    checked && "bg-[var(--accent-bg)]",
                  )}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggleClass(c.id)}
                    className="shrink-0"
                  />
                  <span
                    className="h-2.5 w-2.5 shrink-0 rounded-full border border-[var(--border-strong)]"
                    style={{ background: c.color }}
                  />
                  <span className="text-[12.5px] text-[color:var(--text-primary)] shrink-0">
                    {c.name}
                  </span>
                  <span className="flex-1 text-[11.5px] text-[color:var(--text-tertiary)] truncate italic">
                    {c.text_prompt}
                  </span>
                </label>
              );
            })}
            {eligibleClasses.length === 0 && (
              <p className="text-[12px] text-[color:var(--text-tertiary)] italic px-3 py-3">
                No classes have a text prompt yet. Add one in the Classes
                editor (right panel: type below the class name).
              </p>
            )}
            {ineligibleClasses.length > 0 && eligibleClasses.length > 0 && (
              <p className="text-[10.5px] text-[color:var(--text-tertiary)] italic px-3 py-1.5 mt-1 border-t border-[var(--border-subtle)]">
                {ineligibleClasses.length} class
                {ineligibleClasses.length === 1 ? "" : "es"} hidden -- no text
                prompt configured.
              </p>
            )}
          </div>
        </div>

        {/* Find mode */}
        <div className="grid gap-2 mb-4">
          <div className="text-[11px] uppercase tracking-[0.16em] text-[color:var(--text-tertiary)]">
            Find
          </div>
          <div className="flex gap-3 text-[12.5px] text-[color:var(--text-primary)]">
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input
                type="radio"
                name="auto-annotate-find"
                checked={findAll}
                onChange={() => setFindAll(true)}
              />
              All instances
            </label>
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input
                type="radio"
                name="auto-annotate-find"
                checked={!findAll}
                onChange={() => setFindAll(false)}
              />
              Best match only
            </label>
          </div>
        </div>

        {/* Threshold */}
        <div className="grid gap-2 mb-4">
          <div className="flex items-center justify-between">
            <span className="text-[11px] uppercase tracking-[0.16em] text-[color:var(--text-tertiary)]">
              Score &ge;
            </span>
            <span className="font-mono text-[12px] text-[color:var(--text-primary)]">
              {threshold.toFixed(2)}
            </span>
          </div>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={threshold}
            onChange={(e) => setThreshold(parseFloat(e.target.value))}
            data-testid="auto-annotate-threshold"
          />
        </div>

        {/* Scope */}
        <div className="grid gap-2 mb-4">
          <div className="text-[11px] uppercase tracking-[0.16em] text-[color:var(--text-tertiary)]">
            Scope
          </div>
          <div className="flex flex-col gap-1.5 text-[12.5px] text-[color:var(--text-primary)]">
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input
                type="radio"
                name="auto-annotate-scope"
                checked={scope === "this"}
                onChange={() => setScope("this")}
              />
              This image
            </label>
            <label
              className={cn(
                "flex items-center gap-1.5",
                taskId ? "cursor-pointer" : "opacity-50 cursor-not-allowed",
              )}
              title={
                taskId ? "Run on all assets in this task" : "Task id missing"
              }
            >
              <input
                type="radio"
                name="auto-annotate-scope"
                checked={scope === "all"}
                disabled={!taskId}
                onChange={() => setScope("all")}
              />
              All assets in this task
            </label>
          </div>
        </div>

        {/* Overwrite */}
        <label className="flex items-center gap-2 mb-2 text-[12.5px] text-[color:var(--text-primary)] cursor-pointer">
          <input
            type="checkbox"
            checked={overwrite}
            onChange={(e) => setOverwrite(e.target.checked)}
            data-testid="auto-annotate-overwrite"
          />
          Replace existing annotations for selected classes
        </label>

        <DialogFooter>
          <Button variant="ghost" size="md" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="md"
            disabled={!canRun}
            loading={run.isPending}
            onClick={() => run.mutate()}
            data-testid="auto-annotate-run"
          >
            Run
          </Button>
        </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

// v3.8 Phase 3.5 — live batch progress view rendered inside the
// Auto-annotate dialog after the user enqueues a multi-asset run.
// Polls /tasks/.../auto-text-batch/{job_id} every 1.2s; auto-dismisses
// on terminal status. Cancel writes status=canceled into Redis so the
// worker exits its loop after the in-flight asset commits.
function BatchProgressView({
  taskId,
  jobId,
  onDone,
}: {
  taskId: string;
  jobId: string;
  onDone: (final: {
    status: string;
    total_annotations_created: number;
    failed: number;
  } | null) => void;
}) {
  const [canceling, setCanceling] = useState(false);
  const POLL_INTERVAL_MS = 1200;
  const statusQ = useQuery({
    queryKey: ["sam-auto-text-batch", taskId, jobId],
    queryFn: () => samApi.autoTextBatchProgress(taskId, jobId),
    refetchInterval: (q) => {
      const s = q.state.data?.status;
      if (
        s === "completed" ||
        s === "completed_with_errors" ||
        s === "failed" ||
        s === "canceled"
      ) {
        return false;
      }
      return POLL_INTERVAL_MS;
    },
    refetchIntervalInBackground: false,
    staleTime: 0,
  });

  const data = statusQ.data;
  const status = data?.status;
  useEffect(() => {
    if (
      status === "completed" ||
      status === "completed_with_errors" ||
      status === "failed" ||
      status === "canceled"
    ) {
      onDone(data ?? null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  const total = data?.total ?? 0;
  const done = data?.done ?? 0;
  const failed = data?.failed ?? 0;
  const created = data?.total_annotations_created ?? 0;
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;

  return (
    <div className="grid gap-3">
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <Loader2 className="h-4 w-4 animate-spin text-[color:var(--accent)]" />
          Running on the whole task…
        </DialogTitle>
        <DialogDescription>
          {total > 0
            ? `Asset ${done} of ${total} (${pct}%) — ${created} annotation${created === 1 ? "" : "s"} created.`
            : "Initialising…"}
        </DialogDescription>
      </DialogHeader>
      <div className="h-2 rounded-full bg-[var(--bg-sunken)] overflow-hidden">
        <div
          className="h-full bg-[var(--accent)] transition-[width] duration-300"
          style={{ width: `${pct}%` }}
        />
      </div>
      {failed > 0 && (
        <p className="text-[11.5px] text-[color:var(--warning,oklch(0.78_0.18_85))]">
          {failed} asset{failed === 1 ? "" : "s"} failed (kept the rest).
        </p>
      )}
      <p className="text-[11px] text-[color:var(--text-tertiary)] italic">
        Annotations save per-asset, so cancelling keeps everything done so far.
      </p>
      <DialogFooter>
        <Button
          variant="danger"
          size="md"
          disabled={canceling}
          loading={canceling}
          leftIcon={<X className="h-3.5 w-3.5" />}
          onClick={async () => {
            setCanceling(true);
            try {
              await samApi.autoTextBatchCancel(taskId, jobId);
              showToast("Cancellation requested.", {
                variant: "warning",
                duration: 2500,
              });
            } catch {
              showToast("Failed to cancel.", { variant: "error" });
            } finally {
              setCanceling(false);
            }
          }}
        >
          Cancel
        </Button>
      </DialogFooter>
    </div>
  );
}
