// Armin Mehri — mehri.armin@gmail.com
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Sparkles, X } from "lucide-react";

import { samApi } from "@/api/sam";
import { modelsApi } from "@/api/phase2";
import type { ClassRow } from "@/api/classes";
import {
  newAnnotationIdsSince,
  runBatchTaskPostProcess,
  runSamPostProcess,
  snapshotAnnotationIds,
  type PostProcessMode,
} from "@/lib/samPostProcess";
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
import { Checkbox } from "@/components/ui/Checkbox";
import { showToast } from "@/lib/toast";
import { cn } from "@/lib/cn";
import { useBackgroundJobs } from "@/state/backgroundJobs";

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
  // v3.21+ — VLM-FO1 precision filter opt-in. v3.22 always defaults to
  // OFF on dialog open: FO1 holds ~6 GB of GPU weights once loaded
  // (lazy-loaded on first /filter call), and an "auto-on" toggle would
  // surprise users into running heavyweight inference. The user opts
  // in per-session; we no longer seed from a stored per-user pref.
  const [useVlmFo1, setUseVlmFo1] = useState<boolean>(false);
  // Phase 3.5: only "this" is wired. "all" reserved for Phase 3.6 (RQ batch).
  const [scope, setScope] = useState<"this" | "all">("this");
  // v3.8 Phase 3.5 — track an in-flight RQ batch so the dialog can
  // render a live progress overlay with Cancel.
  const [runningJobId, setRunningJobId] = useState<string | null>(null);

  // v3.22 — expand-from-bar handshake. When the operator clicks
  // "Expand" on a backgrounded job in the floating bar, the bar
  // sets ``expandRequest`` in the global store. We watch for our
  // task's job id, re-open the dialog in progress mode, then clear
  // the request and unregister the job from the bar (the dialog now
  // owns the polling again).
  const bgExpandRequest = useBackgroundJobs((s) => s.expandRequest);
  const bgJobs = useBackgroundJobs((s) => s.jobs);
  useEffect(() => {
    if (!bgExpandRequest || !taskId) return;
    const job = bgJobs[bgExpandRequest];
    if (!job || job.taskId !== taskId) return;
    setRunningJobId(bgExpandRequest);
    setOpen(true);
    useBackgroundJobs.getState().remove(bgExpandRequest);
    useBackgroundJobs.getState().clearExpandRequest();
  }, [bgExpandRequest, bgJobs, taskId]);
  // Plan-17 Phase 2 — opt-in post-processing for the SAM-text auto-
  // annotate output. SAM's auto-text produces polygons; the user can
  // optionally convert them to bboxes (instant, no SAM call) once
  // the run finishes. ``samPostMode === "off"`` skips the pass.
  const [samPostMode, setSamPostMode] = useState<"off" | "to-bbox">(
    "off",
  );
  const [samPostProgress, setSamPostProgress] = useState<{
    done: number;
    total: number;
    failed: number;
  } | null>(null);
  const beforeRunIdsRef = useRef<Set<string> | null>(null);
  // Plan-19 — captured at run-start so a batch (all-assets) post-process
  // can scope itself to annotations the run produced.
  const runStartIsoRef = useRef<string | null>(null);

  const eligibleClasses = useMemo(
    () => classes.filter((c) => (c.text_prompt ?? "").trim().length > 0),
    [classes],
  );
  const ineligibleClasses = useMemo(
    () => classes.filter((c) => !(c.text_prompt ?? "").trim()),
    [classes],
  );

  // v3.21+ — capability gate: hide the FO1 toggle when the model
  // service isn't advertising it. Only fetched while the dialog is open.
  const samStatusQuery = useQuery({
    queryKey: ["sam", "status", "vlm-fo1-cap"],
    queryFn: () => modelsApi.samStatus(),
    enabled: open,
    refetchOnWindowFocus: false,
    staleTime: 30_000,
  });
  // FO1 only makes sense on SAM 3 family variants — the /sam/text-prompt
  // endpoint already 409s when the variant is sam2.x, and the multiplex
  // sam3.1 backend doesn't ship a transformers-compatible image runtime.
  // Hide the toggle in those cases so users don't see a dead control.
  const samVariant = samStatusQuery.data?.variant ?? "";
  const isSam3Family = samVariant === "sam3";
  const vlmFo1Available =
    samStatusQuery.data?.vlm_fo1_available === true && isSam3Family;

  // v3.22 — no longer seed from per-user pref. The toggle starts OFF
  // each time the dialog opens (see useState above). Existing per-user
  // pref rows on the server are intentionally ignored; the API
  // endpoints are kept around for backwards compatibility with older
  // clients but this dialog no longer reads or writes them.

  const run = useMutation({
    mutationFn: async () => {
      // Plan-17 Phase 2 — capture snapshot of annotation IDs before
      // the run kicks off so onSuccess can diff and find rows that
      // SAM auto-text produced (vs. pre-existing ones on the asset).
      if (samPostMode !== "off") {
        beforeRunIdsRef.current = snapshotAnnotationIds();
        runStartIsoRef.current = new Date().toISOString();
      } else {
        beforeRunIdsRef.current = null;
        runStartIsoRef.current = null;
      }
      // v3.8 Phase 3.5 — branch on scope. "this" is sync; "all" enqueues
      // an RQ batch and we return a pseudo-result the onSuccess can
      // recognise by the presence of a `job_id` field.
      // v3.21+ — only forward use_vlm_fo1 when the server actually
      // supports it AND the user opted in. Sending the flag to a server
      // without the capability is harmless but pointless.
      const wireUseVlmFo1 = vlmFo1Available && useVlmFo1;
      if (scope === "all") {
        if (!taskId) throw new Error("no_task");
        const r = await samApi.autoTextBatch(taskId, {
          class_ids: Array.from(selectedClassIds),
          threshold,
          find_all: findAll,
          overwrite,
          ...(wireUseVlmFo1 ? { use_vlm_fo1: true } : {}),
        });
        return { kind: "batch", job_id: r.job_id } as const;
      }
      if (!assetId) throw new Error("no_asset");
      const r = await samApi.autoText(assetId, {
        class_ids: Array.from(selectedClassIds),
        threshold,
        find_all: findAll,
        overwrite,
        ...(wireUseVlmFo1 ? { use_vlm_fo1: true } : {}),
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
      // Plan-17 Phase 2 — opt-in post-processing pass over the rows
      // SAM auto-text just produced. Currently the only mode wired
      // for this dialog is "to-bbox" (instant, pure-client). Mode
      // "off" closes the dialog immediately as before.
      const beforeIds = beforeRunIdsRef.current;
      beforeRunIdsRef.current = null;
      if (samPostMode !== "off" && beforeIds && assetId && result.annotations_created > 0) {
        setTimeout(() => {
          const newIds = newAnnotationIdsSince(beforeIds);
          if (newIds.length === 0) {
            setOpen(false);
            return;
          }
          setSamPostProgress({ done: 0, total: newIds.length, failed: 0 });
          void runSamPostProcess({
            assetId,
            frameId: null,
            annotationIds: newIds,
            mode: samPostMode as PostProcessMode,
            onProgress: setSamPostProgress,
          })
            .then((postResult) => {
              if (postResult.succeeded > 0) {
                showToast(
                  `Converted ${postResult.succeeded} polygon${postResult.succeeded === 1 ? "" : "s"} to bbox${postResult.failed > 0 ? ` (${postResult.failed} skipped)` : ""}.`,
                  { variant: "success" },
                );
              }
              setSamPostProgress(null);
              setOpen(false);
            })
            .catch(() => {
              showToast("Post-process failed.", { variant: "error" });
              setSamPostProgress(null);
              setOpen(false);
            });
        }, 600);
      } else {
        setOpen(false);
      }
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
              // DESIGN.md §4 — primary CTA pill: PS Blue at rest, full
              // hover signature (cyan fill + white border + blue ring +
              // 1.05× lift, 180ms ease).
              "inline-flex h-8 items-center gap-1.5 px-3 rounded-[var(--radius-pill)]",
              "bg-[var(--accent)] text-white text-[12.5px] font-medium tracking-[0.4px]",
              "border border-[var(--accent)]",
              "transition-all duration-[180ms] ease-out",
              "hover:bg-[var(--accent-hover)] hover:border-white",
              "hover:shadow-[0_0_0_2px_var(--accent)] hover:scale-[1.05]",
              "active:opacity-60 active:scale-100",
              "disabled:bg-[var(--bg-subtle)] disabled:border-[var(--border-subtle)] disabled:text-[color:var(--text-tertiary)] disabled:cursor-not-allowed disabled:hover:scale-100 disabled:hover:shadow-none",
            )}
            title="Auto-annotate (SAM 3 text prompts)"
          >
            <Sparkles className="h-3.5 w-3.5" />
            Auto
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
              // Plan-19 — task-wide post-process. Only run when the user
              // ticked "Convert polygons to bboxes after" AND the batch
              // actually produced rows AND we have a run-start timestamp
              // to scope by. The dialog stays mounted so the user sees
              // the conversion progress before we close.
              if (
                samPostMode !== "off" &&
                created > 0 &&
                runStartIsoRef.current &&
                taskId
              ) {
                const startIso = runStartIsoRef.current;
                runStartIsoRef.current = null;
                setSamPostProgress({ done: 0, total: created, failed: 0 });
                void runBatchTaskPostProcess({
                  taskId,
                  sinceIso: startIso,
                  classIds: selectedClassIds,
                  mode: samPostMode as PostProcessMode,
                  onProgress: setSamPostProgress,
                })
                  .then((res) => {
                    if (res.succeeded > 0) {
                      showToast(
                        `Converted ${res.succeeded} polygon${res.succeeded === 1 ? "" : "s"} to bbox${res.failed > 0 ? ` · ${res.failed} kept original (degenerate geometry)` : ""}.`,
                        {
                          variant: res.failed > 0 ? "warning" : "success",
                          duration: 6000,
                        },
                      );
                    }
                  })
                  .catch(() => {
                    showToast("Batch post-process failed.", {
                      variant: "error",
                    });
                  })
                  .finally(() => {
                    setSamPostProgress(null);
                    qc.invalidateQueries({ queryKey: ["annotations"] });
                    qc.invalidateQueries({ queryKey: ["task-assets", taskId] });
                    setRunningJobId(null);
                    setOpen(false);
                  });
                return;
              }
              setRunningJobId(null);
              setOpen(false);
            }}
            postProgress={samPostProgress}
            onBackground={
              taskId
                ? () => {
                    // v3.22 — minimize the dialog without canceling.
                    // Register the running job in the global background
                    // store so the floating <BackgroundJobsBar /> takes
                    // over progress polling + cancel UX. The user can
                    // expand back via the bar (see useEffect on
                    // expandRequest below).
                    const jobId = runningJobId!;
                    const cap = taskId;
                    useBackgroundJobs.getState().add({
                      jobId,
                      taskId: cap,
                      kind: "sam-auto-text",
                      label: "SAM auto-annotate",
                      startedAt: Date.now(),
                      cancel: async () => {
                        await samApi.autoTextBatchCancel(cap, jobId);
                      },
                    });
                    setRunningJobId(null);
                    setOpen(false);
                    showToast("Running in background — progress shown bottom-right.", {
                      variant: "info",
                      duration: 3000,
                    });
                  }
                : undefined
            }
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
                  <Checkbox
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

        {/* v3.21+ — VLM-FO1 precision filter toggle. Hidden when the
            model service hasn't registered a filter (capability gate)
            so users on FO1-less deployments don't see a dead control. */}
        {vlmFo1Available && (
          <label
            className="flex items-center gap-2 mb-2 text-[12.5px] text-[color:var(--text-primary)] cursor-pointer"
            title="Run a vision-language precision filter on top of SAM 3 mask proposals. Slower but reduces false positives on compositional prompts. Beta."
          >
            <Checkbox
              checked={useVlmFo1}
              onChange={(e) => setUseVlmFo1(e.target.checked)}
              data-testid="auto-annotate-vlm-fo1"
            />
            <span className="flex-1">
              VLM-FO1 smart filter
              <span className="ml-1 font-mono text-[10px] text-[color:var(--text-tertiary)]">
                beta · slower · higher precision
              </span>
            </span>
          </label>
        )}

        {/* Overwrite */}
        <label className="flex items-center gap-2 mb-2 text-[12.5px] text-[color:var(--text-primary)] cursor-pointer">
          <Checkbox
            checked={overwrite}
            onChange={(e) => setOverwrite(e.target.checked)}
            data-testid="auto-annotate-overwrite"
          />
          Replace existing annotations for selected classes
        </label>

        {/* Plan-17 Phase 2 — opt-in post-processing. SAM auto-text
            produces polygons; this lets the user immediately convert
            them to bboxes after the run, with realtime progress.
            Disabled for "all assets in task" scope (single-asset
            post-processing only — for batch use marquee+right-click). */}
        <div className="grid gap-1.5 mb-3">
          <label className="flex items-center gap-2 text-[12.5px] text-[color:var(--text-primary)] cursor-pointer">
            <Checkbox
              checked={samPostMode !== "off"}
              onChange={(e) =>
                setSamPostMode(e.target.checked ? "to-bbox" : "off")
              }
              data-testid="auto-annotate-post-toggle"
            />
            <span className="flex-1">
              Convert polygons to bboxes after
              <span className="ml-1 font-mono text-[10px] text-[color:var(--text-tertiary)]">
                {scope === "all" ? "task-wide" : "instant"}
              </span>
            </span>
          </label>
          {samPostProgress && (
            <div
              data-testid="auto-annotate-post-progress"
              className="ml-5 grid gap-1"
            >
              <div className="flex items-center justify-between text-[10.5px]">
                <span className="text-[color:var(--text-secondary)]">
                  Converting…
                </span>
                <span className="font-mono tabular-nums text-[color:var(--text-tertiary)]">
                  {samPostProgress.done}/{samPostProgress.total}
                  {samPostProgress.failed > 0
                    ? ` · ${samPostProgress.failed} skipped`
                    : ""}
                </span>
              </div>
              <div className="relative h-1 overflow-hidden rounded-full bg-[var(--bg-hover)]">
                <div
                  className="absolute inset-y-0 left-0 bg-[var(--accent)] transition-[width] duration-200"
                  style={{
                    width:
                      samPostProgress.total > 0
                        ? `${Math.round((samPostProgress.done / samPostProgress.total) * 100)}%`
                        : "0%",
                  }}
                />
              </div>
            </div>
          )}
        </div>

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
  postProgress,
  onBackground,
}: {
  taskId: string;
  jobId: string;
  onDone: (final: {
    status: string;
    total_annotations_created: number;
    failed: number;
  } | null) => void;
  postProgress?: { done: number; total: number; failed: number } | null;
  onBackground?: () => void;
}) {
  const [canceling, setCanceling] = useState(false);
  // Plan-20.11 — was 1200 ms; reduced to 500 ms so the user sees
  // worker progress ticks promptly. The polled endpoint is a cheap
  // Redis hash read so the higher rate is fine.
  const POLL_INTERVAL_MS = 500;
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
      {postProgress && (
        <div data-testid="auto-annotate-batch-post" className="grid gap-1">
          <div className="flex items-center justify-between text-[11px]">
            <span className="text-[color:var(--text-secondary)]">
              Converting polygons to bboxes — {postProgress.done.toLocaleString()}{" "}
              of {postProgress.total.toLocaleString()} annotation
              {postProgress.total === 1 ? "" : "s"}
            </span>
            <span className="font-mono tabular-nums text-[color:var(--text-tertiary)]">
              {postProgress.total > 0
                ? `${Math.round((postProgress.done / postProgress.total) * 100)}%`
                : ""}
              {postProgress.failed > 0 ? ` · ${postProgress.failed} skipped` : ""}
            </span>
          </div>
          <div className="h-1.5 rounded-full bg-[var(--bg-sunken)] overflow-hidden">
            <div
              className="h-full bg-[var(--accent)] transition-[width] duration-150"
              style={{
                width:
                  postProgress.total > 0
                    ? `${Math.round((postProgress.done / postProgress.total) * 100)}%`
                    : "0%",
              }}
            />
          </div>
          <p className="text-[10.5px] text-[color:var(--text-tertiary)] leading-snug">
            One annotation per detected object — totals the new rows the
            run produced across all assets.
          </p>
        </div>
      )}
      <p className="text-[11px] text-[color:var(--text-tertiary)] italic">
        Annotations save per-asset, so cancelling keeps everything done so far.
      </p>
      <DialogFooter className="flex-row gap-2">
        {onBackground && (
          <Button
            variant="ghost"
            size="md"
            onClick={onBackground}
            data-testid="auto-annotate-batch-background"
          >
            Background
          </Button>
        )}
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
