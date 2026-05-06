// Armin Mehri — mehri.armin@gmail.com
/**
 * YOLOE — Real-Time Seeing Anything (v3.23).
 *
 * One dialog, three modes: Text Prompt, Visual Prompt, Prompt-Free.
 * Each mode supports both "current asset" and "all assets in task"
 * scopes. Capability-gated: when the model service has no YOLOE
 * checkpoints, the dialog renders a disabled state with operator
 * hints instead of pretending to work.
 *
 * Architecture mirrors AutoAnnotateDialog so the editor's existing
 * progress + cancel + Background scaffolding (BackgroundJobsBar,
 * useBackgroundJobs) wires up uniformly.
 */
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  ScanEye,
  Sparkles,
  Type,
  X,
} from "lucide-react";

import { yoloeApi } from "@/api/yoloe";
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
import { Checkbox } from "@/components/ui/Checkbox";
import { showToast } from "@/lib/toast";
import { cn } from "@/lib/cn";
import { useBackgroundJobs } from "@/state/backgroundJobs";

type YoloeMode = "text" | "visual" | "prompt_free";
type Scope = "this" | "all";

interface YoloeDialogProps {
  /** The asset currently open in the editor. Used for "this image". */
  assetId: string | null;
  /** Optional task id for the multi-asset RQ batch path. */
  taskId?: string;
  /** All classes in this project — needed for visual / prompt-free
   *  "annotate as" picker and for class-name auto-suggestions. */
  classes: ClassRow[];
  /** Optional render override for the trigger button. */
  trigger?: React.ReactNode;
  /** Called after a successful sync run so the editor can refetch. */
  onSuccess?: (createdCount: number) => void;
}

const MODE_TABS: { id: YoloeMode; label: string; sub: string; icon: React.ReactNode }[] = [
  {
    id: "text",
    label: "Text Prompt",
    sub: "Open vocabulary",
    icon: <Type className="h-4 w-4" />,
  },
  {
    id: "visual",
    label: "Visual Prompt",
    sub: "Reference image",
    icon: <ScanEye className="h-4 w-4" />,
  },
  {
    id: "prompt_free",
    label: "Prompt-Free",
    sub: "1200+ classes",
    icon: <Sparkles className="h-4 w-4" />,
  },
];

export function YoloeDialog({
  assetId,
  taskId,
  classes,
  trigger,
  onSuccess,
}: YoloeDialogProps) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<YoloeMode>("text");
  const [scope, setScope] = useState<Scope>("this");

  // Text mode state
  const [classChips, setClassChips] = useState<string[]>([]);
  const [classInput, setClassInput] = useState("");

  // Visual mode state
  const [visualBboxText, setVisualBboxText] = useState("");
  const [visualClassId, setVisualClassId] = useState<string>("");

  // Prompt-free mode state
  const [pfClassId, setPfClassId] = useState<string>("");
  const [pfMaxDet, setPfMaxDet] = useState<number>(100);

  // Common controls
  const [conf, setConf] = useState<number>(0.25);
  const [iou, setIou] = useState<number>(0.7);
  const [minConfidence, setMinConfidence] = useState<number>(0.0);
  const [overwrite, setOverwrite] = useState<boolean>(false);

  // Active batch tracking
  const [runningJobId, setRunningJobId] = useState<string | null>(null);

  // Pick up "Expand" requests for our task's yoloe-batch jobs.
  const bgExpandRequest = useBackgroundJobs((s) => s.expandRequest);
  const bgJobs = useBackgroundJobs((s) => s.jobs);
  useEffect(() => {
    if (!bgExpandRequest || !taskId) return;
    const job = bgJobs[bgExpandRequest];
    if (!job || job.taskId !== taskId) return;
    if (job.kind !== "yoloe-batch") return;
    setRunningJobId(bgExpandRequest);
    setOpen(true);
    queueMicrotask(() => {
      useBackgroundJobs.getState().remove(bgExpandRequest);
      useBackgroundJobs.getState().clearExpandRequest();
    });
  }, [bgExpandRequest, bgJobs, taskId]);

  // Capability gate — only fetched while the dialog is open.
  const statusQ = useQuery({
    queryKey: ["yoloe", "status"],
    queryFn: () => yoloeApi.status(),
    enabled: open,
    refetchOnWindowFocus: false,
    staleTime: 30_000,
  });
  const available = statusQ.data?.available === true;
  const textAvailable = statusQ.data?.text_available === true;
  const pfAvailable = statusQ.data?.pf_available === true;

  // Default to whichever variant is actually available.
  useEffect(() => {
    if (!open || !statusQ.data) return;
    if (mode === "text" && !textAvailable && pfAvailable) {
      setMode("prompt_free");
    }
    if (mode === "prompt_free" && !pfAvailable && textAvailable) {
      setMode("text");
    }
    if (mode === "visual" && !textAvailable) {
      setMode(pfAvailable ? "prompt_free" : "text");
    }
  }, [open, statusQ.data, mode, textAvailable, pfAvailable]);

  function addChip(raw: string) {
    const cleaned = raw.trim();
    if (!cleaned) return;
    setClassChips((prev) =>
      prev.includes(cleaned) ? prev : [...prev, cleaned],
    );
    setClassInput("");
  }
  function removeChip(c: string) {
    setClassChips((prev) => prev.filter((x) => x !== c));
  }

  function parseBbox(text: string): [number, number, number, number] | null {
    const parts = text
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean)
      .map(Number);
    if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return null;
    return [parts[0]!, parts[1]!, parts[2]!, parts[3]!];
  }

  async function fetchAssetAsBase64(url: string): Promise<string> {
    const res = await fetch(url);
    const blob = await res.blob();
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        const result = String(reader.result || "");
        const idx = result.indexOf(",");
        resolve(idx >= 0 ? result.slice(idx + 1) : result);
      };
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  }

  const canRun = useMemo(() => {
    if (!available) return false;
    if (scope === "all" && !taskId) return false;
    if (mode === "text") {
      return textAvailable && classChips.length > 0;
    }
    if (mode === "visual") {
      return (
        textAvailable &&
        !!parseBbox(visualBboxText) &&
        !!visualClassId &&
        !!assetId
      );
    }
    return pfAvailable;
  }, [
    available, scope, taskId, mode, textAvailable, pfAvailable,
    classChips.length, visualBboxText, visualClassId, assetId,
  ]);

  const run = useMutation({
    mutationFn: async () => {
      if (scope === "this") {
        if (!assetId) throw new Error("no_asset");
        if (mode === "text") {
          return await yoloeApi.textPredict(assetId, {
            classes: classChips,
            conf,
            iou,
            min_confidence: minConfidence,
            overwrite,
          });
        }
        if (mode === "visual") {
          const bbox = parseBbox(visualBboxText)!;
          const refer_b64 = await fetchAssetAsBase64(`/api/assets/${assetId}/image`);
          return await yoloeApi.visualPredict(assetId, {
            refer_b64,
            bboxes: [bbox],
            cls_indices: [0],
            class_names: ["target"],
            annotate_as_class_id: visualClassId,
            conf,
            iou,
            min_confidence: minConfidence,
            overwrite,
          });
        }
        return await yoloeApi.promptFreePredict(assetId, {
          annotate_as_class_id: pfClassId || null,
          conf,
          iou,
          min_confidence: minConfidence,
          max_detections: pfMaxDet || null,
          overwrite,
        });
      }
      // Batch path
      if (!taskId) throw new Error("no_task");
      let params: Record<string, unknown> = {};
      if (mode === "text") {
        params = { classes: classChips, conf, iou };
      } else if (mode === "visual") {
        const bbox = parseBbox(visualBboxText)!;
        if (!assetId) throw new Error("no_asset");
        const refer_b64 = await fetchAssetAsBase64(`/api/assets/${assetId}/image`);
        params = {
          refer_b64,
          bboxes: [bbox],
          cls_indices: [0],
          class_names: ["target"],
          annotate_as_class_id: visualClassId,
          conf,
          iou,
        };
      } else {
        params = {
          annotate_as_class_id: pfClassId || null,
          conf,
          iou,
          max_detections: pfMaxDet || null,
        };
      }
      const r = await yoloeApi.enqueueBatch(taskId, {
        mode,
        params,
        overwrite,
        min_confidence: minConfidence,
      });
      return { job_id: r.job_id };
    },
    onSuccess: (data) => {
      if (
        data &&
        typeof data === "object" &&
        "job_id" in data &&
        typeof (data as { job_id?: string }).job_id === "string" &&
        !("annotations" in data)
      ) {
        setRunningJobId((data as { job_id: string }).job_id);
        return;
      }
      const created = (data as { annotations_created?: number }).annotations_created ?? 0;
      const skipped = (data as { skipped_count?: number }).skipped_count ?? 0;
      onSuccess?.(created);
      qc.invalidateQueries({ queryKey: ["annotations"] });
      if (taskId) {
        qc.invalidateQueries({ queryKey: ["task-annotations", taskId] });
        qc.invalidateQueries({ queryKey: ["task-assets", taskId] });
      }
      const tail = skipped > 0 ? ` · skipped ${skipped}` : "";
      showToast(
        `YOLOE created ${created} annotation${created === 1 ? "" : "s"}${tail}.`,
        {
          variant: created > 0 ? "success" : "warning",
          duration: 5000,
        },
      );
      setOpen(false);
    },
    onError: (err: unknown) => {
      const msg =
        err && typeof err === "object" && "message" in err
          ? String((err as { message?: string }).message)
          : "Run failed";
      showToast(`YOLOE: ${msg}`, { variant: "error", duration: 5000 });
    },
  });

  function resetState() {
    setRunningJobId(null);
  }

  const fallbackTrigger = (
    <button
      type="button"
      data-testid="yoloe-open"
      className={cn(
        "inline-flex items-center gap-1.5 h-7 px-2.5 rounded-[var(--radius-pill)]",
        "border border-[var(--border-subtle)] bg-[var(--bg-elev)]",
        "text-[12px] text-[color:var(--text-primary)] font-medium",
        "transition-all duration-[180ms] ease-out",
        "hover:bg-[var(--bg-hover)] hover:border-[color:var(--accent)]",
      )}
    >
      <ScanEye className="h-3.5 w-3.5 text-[color:var(--accent)]" />
      <span>YOLOE</span>
    </button>
  );

  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) resetState(); }}>
      <DialogTrigger asChild>{trigger ?? fallbackTrigger}</DialogTrigger>
      <DialogContent
        data-testid="yoloe-dialog"
        className="max-w-[640px] grid gap-3"
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ScanEye className="h-4 w-4 text-[color:var(--accent)]" />
            YOLOE
            <span className="text-[11px] font-normal text-[color:var(--text-tertiary)]">
              Real-Time Seeing Anything
            </span>
          </DialogTitle>
          <DialogDescription>
            Detect and segment open-vocabulary objects with text, visual, or
            prompt-free modes.
          </DialogDescription>
        </DialogHeader>

        {!available && statusQ.isFetched ? (
          <div
            data-testid="yoloe-unavailable"
            className="grid gap-2 p-4 rounded-[var(--radius-md)] border border-[var(--warning)]/40 bg-[var(--warning)]/10 text-[12.5px]"
          >
            <div className="flex items-start gap-2">
              <AlertTriangle className="h-4 w-4 mt-0.5 text-[color:var(--warning)] shrink-0" aria-hidden />
              <div>
                <div className="font-medium">YOLOE is not available on this server.</div>
                <div className="text-[color:var(--text-secondary)]">
                  Ship the YOLOE checkpoints to the model container
                  (<code className="font-mono">YOLOE_WEIGHTS_DIR</code>) and
                  restart the model service.
                </div>
              </div>
            </div>
          </div>
        ) : runningJobId && taskId ? (
          <YoloeBatchProgress
            taskId={taskId}
            jobId={runningJobId}
            onClose={(final) => {
              setRunningJobId(null);
              const created = final?.total_annotations_created ?? 0;
              const skipped = final?.total_skipped_detections ?? 0;
              const tail = skipped > 0 ? ` · skipped ${skipped}` : "";
              showToast(
                `YOLOE batch created ${created} annotation${created === 1 ? "" : "s"}${tail}.`,
                { variant: created > 0 ? "success" : "warning", duration: 6000 },
              );
              onSuccess?.(created);
              qc.invalidateQueries({ queryKey: ["annotations"] });
              qc.invalidateQueries({ queryKey: ["task-annotations", taskId] });
              qc.invalidateQueries({ queryKey: ["task-assets", taskId] });
              setOpen(false);
            }}
            onBackground={() => {
              const cap = taskId;
              const id = runningJobId;
              useBackgroundJobs.getState().add({
                jobId: id,
                taskId: cap,
                kind: "yoloe-batch",
                label: `YOLOE ${mode.replace("_", "-")} (batch)`,
                startedAt: Date.now(),
                cancel: async () => {
                  await yoloeApi.cancelBatch(cap, id);
                },
              });
              setRunningJobId(null);
              setOpen(false);
              showToast("Running in background — progress shown bottom-right.", {
                variant: "info",
                duration: 3000,
              });
            }}
          />
        ) : (
          <>
            {/* Mode tabs */}
            <div className="grid grid-cols-3 gap-1 p-1 rounded-[var(--radius-md)] bg-[var(--bg-subtle)]">
              {MODE_TABS.map((t) => {
                const active = mode === t.id;
                const dis =
                  (t.id === "text" && !textAvailable) ||
                  (t.id === "visual" && !textAvailable) ||
                  (t.id === "prompt_free" && !pfAvailable);
                return (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => !dis && setMode(t.id)}
                    disabled={dis}
                    data-testid={`yoloe-mode-${t.id}`}
                    className={cn(
                      "flex flex-col items-start gap-0.5 px-3 py-2 rounded-[var(--radius-sm)]",
                      "text-left transition-all duration-[160ms]",
                      active
                        ? "bg-[var(--bg-elev)] shadow-[0_0_0_1px_var(--accent)]"
                        : "hover:bg-[var(--bg-hover)]",
                      dis && "opacity-40 cursor-not-allowed",
                    )}
                  >
                    <span className="flex items-center gap-1.5 text-[12px] font-medium">
                      {t.icon}
                      {t.label}
                    </span>
                    <span className="text-[10.5px] text-[color:var(--text-tertiary)]">
                      {t.sub}
                    </span>
                  </button>
                );
              })}
            </div>

            {/* Mode-specific body */}
            {mode === "text" && (
              <div className="grid gap-2">
                <label className="text-[12px] font-medium text-[color:var(--text-primary)]">
                  Class names
                </label>
                <div className="flex flex-wrap gap-1.5 p-2 rounded-[var(--radius-md)] border border-[var(--border-subtle)] min-h-[44px] bg-[var(--bg-elev)]">
                  {classChips.map((c) => (
                    <span
                      key={c}
                      className="inline-flex items-center gap-1 h-6 px-2 rounded-full bg-[var(--accent)]/15 text-[11.5px]"
                    >
                      {c}
                      <button
                        type="button"
                        onClick={() => removeChip(c)}
                        className="hover:opacity-70"
                        aria-label={`Remove ${c}`}
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </span>
                  ))}
                  <input
                    value={classInput}
                    onChange={(e) => setClassInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === ",") {
                        e.preventDefault();
                        addChip(classInput);
                      } else if (e.key === "Backspace" && !classInput && classChips.length) {
                        removeChip(classChips[classChips.length - 1]!);
                      }
                    }}
                    onBlur={() => addChip(classInput)}
                    placeholder={classChips.length ? "Add another…" : "person, bus, car…"}
                    className="flex-1 min-w-[120px] bg-transparent outline-none text-[12px]"
                    data-testid="yoloe-class-input"
                  />
                </div>
                <p className="text-[10.5px] text-[color:var(--text-tertiary)]">
                  Comma or Enter to add. Detected classes with the same name as
                  one of your project's classes will be auto-mapped.
                </p>
              </div>
            )}

            {mode === "visual" && (
              <div className="grid gap-2">
                <label className="text-[12px] font-medium text-[color:var(--text-primary)]">
                  Reference bbox (xyxy)
                </label>
                <input
                  value={visualBboxText}
                  onChange={(e) => setVisualBboxText(e.target.value)}
                  placeholder="e.g. 100, 200, 300, 500"
                  data-testid="yoloe-visual-bbox"
                  className="h-9 px-3 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-elev)] text-[12px] outline-none focus:border-[color:var(--accent)]"
                />
                <p className="text-[10.5px] text-[color:var(--text-tertiary)]">
                  Coordinates inside the current asset. The model will find
                  visually similar objects in the target asset(s).
                </p>
                <label className="text-[12px] font-medium text-[color:var(--text-primary)] mt-1">
                  Annotate matches as
                </label>
                <select
                  value={visualClassId}
                  onChange={(e) => setVisualClassId(e.target.value)}
                  data-testid="yoloe-visual-class"
                  className="h-9 px-3 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-elev)] text-[12px]"
                >
                  <option value="">Select project class…</option>
                  {classes.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {mode === "prompt_free" && (
              <div className="grid gap-2">
                <label className="text-[12px] font-medium text-[color:var(--text-primary)]">
                  Annotate everything as
                </label>
                <select
                  value={pfClassId}
                  onChange={(e) => setPfClassId(e.target.value)}
                  data-testid="yoloe-pf-class"
                  className="h-9 px-3 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-elev)] text-[12px]"
                >
                  <option value="">Use detected names (name-match)</option>
                  {classes.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
                <label className="text-[12px] font-medium text-[color:var(--text-primary)] mt-1">
                  Max detections
                </label>
                <input
                  type="number"
                  min={1}
                  max={1000}
                  value={pfMaxDet}
                  onChange={(e) => setPfMaxDet(Number(e.target.value) || 0)}
                  data-testid="yoloe-pf-max"
                  className="h-9 px-3 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-elev)] text-[12px] outline-none focus:border-[color:var(--accent)]"
                />
              </div>
            )}

            {/* Common controls */}
            <div className="grid gap-2 mt-1">
              <div className="grid grid-cols-2 gap-1 p-1 rounded-[var(--radius-md)] bg-[var(--bg-subtle)]">
                {(["this", "all"] as Scope[]).map((s) => {
                  const dis = s === "all" && !taskId;
                  const active = scope === s;
                  return (
                    <button
                      key={s}
                      type="button"
                      onClick={() => !dis && setScope(s)}
                      disabled={dis}
                      data-testid={`yoloe-scope-${s}`}
                      className={cn(
                        "px-3 py-1.5 rounded-[var(--radius-sm)] text-[12px] font-medium",
                        "transition-all duration-[160ms]",
                        active
                          ? "bg-[var(--bg-elev)] shadow-[0_0_0_1px_var(--accent)]"
                          : "hover:bg-[var(--bg-hover)]",
                        dis && "opacity-40 cursor-not-allowed",
                      )}
                    >
                      {s === "this" ? "This image" : "All assets in task"}
                    </button>
                  );
                })}
              </div>

              <div className="grid grid-cols-2 gap-3">
                <label className="grid gap-0.5 text-[11px] text-[color:var(--text-secondary)]">
                  <span className="flex items-center justify-between">
                    Confidence threshold
                    <span className="font-mono text-[10.5px] text-[color:var(--text-tertiary)]">
                      {conf.toFixed(2)}
                    </span>
                  </span>
                  <input
                    type="range" min={0} max={1} step={0.05}
                    value={conf}
                    onChange={(e) => setConf(Number(e.target.value))}
                    className="w-full"
                    data-testid="yoloe-conf"
                  />
                </label>
                <label className="grid gap-0.5 text-[11px] text-[color:var(--text-secondary)]">
                  <span className="flex items-center justify-between">
                    IoU (NMS)
                    <span className="font-mono text-[10.5px] text-[color:var(--text-tertiary)]">
                      {iou.toFixed(2)}
                    </span>
                  </span>
                  <input
                    type="range" min={0} max={1} step={0.05}
                    value={iou}
                    onChange={(e) => setIou(Number(e.target.value))}
                    className="w-full"
                    data-testid="yoloe-iou"
                  />
                </label>
              </div>

              <label className="grid gap-0.5 text-[11px] text-[color:var(--text-secondary)]">
                <span className="flex items-center justify-between">
                  Skip detections below confidence
                  <span className="font-mono text-[10.5px] text-[color:var(--text-tertiary)]">
                    {minConfidence.toFixed(2)}
                  </span>
                </span>
                <input
                  type="range" min={0} max={1} step={0.05}
                  value={minConfidence}
                  onChange={(e) => setMinConfidence(Number(e.target.value))}
                  className="w-full"
                  data-testid="yoloe-min-conf"
                />
              </label>

              <label className="flex items-center gap-2 text-[12.5px] text-[color:var(--text-primary)] cursor-pointer">
                <Checkbox
                  checked={overwrite}
                  onChange={(e) => setOverwrite(e.target.checked)}
                  data-testid="yoloe-overwrite"
                />
                Replace existing annotations on this frame
              </label>
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
                data-testid="yoloe-run"
              >
                {scope === "this" ? "Run" : "Run on all assets"}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

// Live progress for an enqueued YOLOE batch.
function YoloeBatchProgress({
  taskId,
  jobId,
  onClose,
  onBackground,
}: {
  taskId: string;
  jobId: string;
  onClose: (final: {
    total_annotations_created: number;
    total_skipped_detections: number;
    failed: number;
    status: string;
  } | null) => void;
  onBackground: () => void;
}) {
  const [canceling, setCanceling] = useState(false);
  const POLL_MS = 600;
  const q = useQuery({
    queryKey: ["yoloe-batch", taskId, jobId],
    queryFn: () => yoloeApi.pollBatch(taskId, jobId),
    refetchInterval: (qq) => {
      const s = qq.state.data?.status;
      if (s === "completed" || s === "completed_with_errors" || s === "failed" || s === "canceled") {
        return false;
      }
      return POLL_MS;
    },
    refetchIntervalInBackground: true,
    staleTime: 0,
  });
  const data = q.data;
  const status = data?.status ?? "pending";
  const done = data?.done ?? 0;
  const total = data?.total ?? 0;
  const failed = data?.failed ?? 0;
  const isTerminal =
    status === "completed" ||
    status === "completed_with_errors" ||
    status === "failed" ||
    status === "canceled";
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;

  return (
    <div
      data-testid="yoloe-batch-progress"
      className="grid gap-3 p-3 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-elev)]"
    >
      <div className="flex items-start gap-2">
        {status === "running" || status === "pending" ? (
          <Loader2 className="h-4 w-4 mt-0.5 text-[color:var(--accent)] animate-spin" />
        ) : status === "failed" || status === "canceled" ? (
          <AlertTriangle className="h-4 w-4 mt-0.5 text-[color:var(--danger)]" />
        ) : (
          <CheckCircle2 className="h-4 w-4 mt-0.5 text-[color:var(--success)]" />
        )}
        <div className="grid gap-0.5 flex-1">
          <div className="text-[12.5px] font-medium">
            YOLOE batch {status === "running" ? "running" : status}
          </div>
          <div className="text-[11px] text-[color:var(--text-secondary)] font-mono tabular-nums">
            {done}/{total}
            {failed > 0 ? ` · ${failed} failed` : ""}
          </div>
        </div>
      </div>
      <div className="relative h-1.5 overflow-hidden rounded-full bg-[var(--bg-hover)]">
        <div
          className={cn(
            "absolute inset-y-0 left-0 transition-[width] duration-200",
            status === "failed" || status === "canceled"
              ? "bg-[var(--danger)]"
              : "bg-[var(--accent)]",
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="flex items-center justify-end gap-2">
        {!isTerminal && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onBackground}
            data-testid="yoloe-batch-background"
          >
            Background
          </Button>
        )}
        {!isTerminal && (
          <Button
            variant="danger"
            size="sm"
            disabled={canceling}
            onClick={async () => {
              setCanceling(true);
              try {
                await yoloeApi.cancelBatch(taskId, jobId);
              } finally {
                setCanceling(false);
              }
            }}
            data-testid="yoloe-batch-cancel"
          >
            {canceling ? "Canceling…" : "Cancel"}
          </Button>
        )}
        {isTerminal && (
          <Button
            variant="primary"
            size="sm"
            onClick={() =>
              onClose(
                data
                  ? {
                      total_annotations_created: data.total_annotations_created,
                      total_skipped_detections: data.total_skipped_detections,
                      failed: data.failed,
                      status: data.status,
                    }
                  : null,
              )
            }
            data-testid="yoloe-batch-done"
          >
            Done
          </Button>
        )}
      </div>
    </div>
  );
}
