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
 * Visual prompt mode UX (v3.23 polish): instead of asking the user
 * to type pixel coordinates, the dialog reads the existing bbox /
 * polygon annotations from the editor's annotations store and lets
 * the user click one (or several) as a visual reference. Polygon
 * annotations are converted to their enclosing bbox before sending.
 * This makes "guide the model by showing it visual examples" the
 * single-click action it should be.
 */
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  Plus,
  ScanEye,
  Sparkles,
  Type,
  Wand2,
  X,
} from "lucide-react";

import { yoloeApi } from "@/api/yoloe";
import type { YoloeOutputKind } from "@/api/yoloe";
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
import { useAnnotations } from "@/state/annotations";
import type { AnnotationDraft } from "@/state/annotations";

type YoloeMode = "text" | "visual" | "prompt_free";
type Scope = "this" | "all";

interface YoloeDialogProps {
  /** The asset currently open in the editor. Used for "this image". */
  assetId: string | null;
  /** Optional task id for the multi-asset RQ batch path. */
  taskId?: string;
  /** All classes in this project — needed for visual / prompt-free
   *  "annotate as" picker and class-color lookup in the visual picker. */
  classes: ClassRow[];
  /** Optional render override for the trigger button. */
  trigger?: React.ReactNode;
  /** Called after a successful sync run so the editor can refetch. */
  onSuccess?: (createdCount: number) => void;
}

const MODE_TABS: {
  id: YoloeMode;
  label: string;
  sub: string;
  icon: React.ReactNode;
}[] = [
  {
    id: "text",
    label: "Text Prompt",
    sub: "Open vocabulary",
    icon: <Type className="h-4 w-4" />,
  },
  {
    id: "visual",
    label: "Visual Prompt",
    sub: "Pick a reference",
    icon: <ScanEye className="h-4 w-4" />,
  },
  {
    id: "prompt_free",
    label: "Prompt-Free",
    sub: "4585+ classes",
    icon: <Sparkles className="h-4 w-4" />,
  },
];

interface VisualReference {
  /** Source annotation id — used as the React key. */
  id: string;
  /** Source kind label for the chip ("bbox" or "polygon"). */
  sourceKind: "bbox" | "polygon";
  /** xyxy in image-space pixels. Polygons are converted to enclosing bbox. */
  xyxy: [number, number, number, number];
  /** Project class name attached to the source annotation, or "<unmapped>". */
  className: string;
  /** Project class id of the source annotation (used as the default
   *  "annotate matches as" pick when the user toggles the ref). */
  sourceClassId: string;
  /** Project class color (CSS color string), or a neutral fallback. */
  color: string;
}

function geometryToXyxy(
  geom: AnnotationDraft["geometry"],
): [number, number, number, number] | null {
  if (geom.kind === "bbox") {
    return [geom.x, geom.y, geom.x + geom.w, geom.y + geom.h];
  }
  if (geom.kind === "polygon" && geom.points.length > 0) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of geom.points) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
    if (maxX <= minX || maxY <= minY) return null;
    return [minX, minY, maxX, maxY];
  }
  return null;
}

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

  // Text mode state — list of (project class, prompt) rows. Default
  // to a single empty row so the user immediately sees the shape of
  // the input. Rows can be added / removed; each row's class can be
  // re-picked independently of the prompt.
  interface TextRow {
    rid: string; // local React key
    classId: string;
    prompt: string;
  }
  const [textRows, setTextRows] = useState<TextRow[]>(() => [
    { rid: `r-${Date.now()}`, classId: "", prompt: "" },
  ]);

  // Visual mode state — for each picked annotation reference, the user
  // assigns a project class. The dialog auto-groups by class_id when
  // building the YOLOE wire payload (one group per project class).
  // Selection-set is implicit in this map's keys; null means "picked
  // but no class chosen yet" → blocks Run.
  const [visualAssign, setVisualAssign] = useState<Record<string, string>>(
    () => ({}),
  );

  // Prompt-free mode state
  const [pfClassId, setPfClassId] = useState<string>("");
  const [pfMaxDet, setPfMaxDet] = useState<number>(300);

  // Common controls
  const [conf, setConf] = useState<number>(0.25);
  const [iou, setIou] = useState<number>(0.7);
  const [overwrite, setOverwrite] = useState<boolean>(false);
  // YOLOE-seg always emits BOTH a bbox and a mask polygon for every
  // detection. Saving both produces stacked duplicates per object,
  // so the user picks ONE shape to commit. Default to bboxes — most
  // workflows annotate boxes first and refine to polygons later.
  const [outputKind, setOutputKind] = useState<YoloeOutputKind>("bbox");

  // Active batch tracking
  const [runningJobId, setRunningJobId] = useState<string | null>(null);

  // Visual picker — read existing annotations from the editor's store.
  // The store is implicitly scoped to whichever frame the canvas is
  // currently rendering. Filter to bbox + polygon kinds.
  const annotationsById = useAnnotations((s) => s.byId);
  const classesById = useMemo(() => {
    const m = new Map<string, ClassRow>();
    for (const c of classes) m.set(c.id, c);
    return m;
  }, [classes]);

  const visualReferences = useMemo<VisualReference[]>(() => {
    const out: VisualReference[] = [];
    for (const [tempId, a] of Object.entries(annotationsById)) {
      if (a.kind !== "bbox" && a.kind !== "polygon") continue;
      const xyxy = geometryToXyxy(a.geometry);
      if (!xyxy) continue;
      const cls = classesById.get(a.classId);
      out.push({
        id: a.serverId ?? tempId,
        sourceKind: a.kind as "bbox" | "polygon",
        xyxy,
        className: cls?.name ?? "<unmapped>",
        sourceClassId: a.classId,
        color: cls?.color ?? "#9ca3af",
      });
    }
    // Sort: bboxes first (more direct visual prompt), then by id stable.
    out.sort((p, q) => {
      if (p.sourceKind !== q.sourceKind) {
        return p.sourceKind === "bbox" ? -1 : 1;
      }
      return p.id.localeCompare(q.id);
    });
    return out;
  }, [annotationsById, classesById]);

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

  // Capability gate. Always-on (low cost; Redis hash on the api side)
  // so the toolbar entry can hide on unavailable.
  const statusQ = useQuery({
    queryKey: ["yoloe", "status"],
    queryFn: () => yoloeApi.status(),
    refetchOnWindowFocus: false,
    staleTime: 60_000,
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

  // Text mode row helpers
  function addTextRow() {
    setTextRows((prev) => [
      ...prev,
      { rid: `r-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, classId: "", prompt: "" },
    ]);
  }
  function removeTextRow(rid: string) {
    setTextRows((prev) =>
      prev.length === 1 ? prev : prev.filter((r) => r.rid !== rid),
    );
  }
  function patchTextRow(rid: string, patch: Partial<TextRow>) {
    setTextRows((prev) =>
      prev.map((r) => (r.rid === rid ? { ...r, ...patch } : r)),
    );
  }

  // Visual selection helpers — toggle picked-state by adding/removing
  // the ref id from the assignment map.
  function toggleVisual(refId: string) {
    setVisualAssign((prev) => {
      if (refId in prev) {
        const { [refId]: _drop, ...rest } = prev;
        return rest;
      }
      const picked = Object.keys(prev).length;
      if (picked >= 16) {
        showToast("Up to 16 visual references per run.", {
          variant: "info",
          duration: 2500,
        });
        return prev;
      }
      // Pre-fill with the source annotation's project class when it
      // maps to one (i.e. the user clicked a bbox of class X — that
      // class becomes the target by default; one click less work).
      const sourceClassId =
        visualReferences.find((r) => r.id === refId)?.sourceClassId ?? "";
      return { ...prev, [refId]: sourceClassId };
    });
  }
  function setVisualClass(refId: string, classId: string) {
    setVisualAssign((prev) => ({ ...prev, [refId]: classId }));
  }

  // Build the YOLOE wire payload: one group per distinct class_id,
  // each group's bboxes drawn from every ref the user assigned to it.
  function buildVisualGroups():
    | { class_id: string; bboxes: [number, number, number, number][] }[]
    | null {
    const byClass = new Map<string, [number, number, number, number][]>();
    for (const r of visualReferences) {
      const cid = visualAssign[r.id];
      if (!cid) continue;
      const arr = byClass.get(cid) ?? [];
      arr.push(r.xyxy);
      byClass.set(cid, arr);
    }
    if (byClass.size === 0) return null;
    return Array.from(byClass.entries()).map(([class_id, bboxes]) => ({
      class_id,
      bboxes,
    }));
  }

  // Text rows are valid when at least one row has BOTH a class chosen
  // AND a non-empty prompt. Empty rows below are silently dropped.
  const textValidRows = useMemo(
    () =>
      textRows.filter(
        (r) => r.classId && (r.prompt || "").trim().length > 0,
      ),
    [textRows],
  );

  const visualGroupsCount = useMemo(
    () =>
      Object.values(visualAssign).filter((cid) => cid && cid.length > 0).length,
    [visualAssign],
  );

  const canRun = useMemo(() => {
    if (!available) return false;
    if (scope === "all" && !taskId) return false;
    if (mode === "text") {
      return textAvailable && textValidRows.length > 0;
    }
    if (mode === "visual") {
      // Every picked ref must have a class assigned; at least one ref.
      const picked = Object.keys(visualAssign);
      if (picked.length === 0) return false;
      const allAssigned = picked.every(
        (rid) => (visualAssign[rid] || "").length > 0,
      );
      return textAvailable && allAssigned && !!assetId;
    }
    return pfAvailable;
  }, [
    available,
    scope,
    taskId,
    mode,
    textAvailable,
    pfAvailable,
    textValidRows.length,
    visualAssign,
    assetId,
  ]);

  const run = useMutation({
    mutationFn: async () => {
      if (scope === "this") {
        if (!assetId) throw new Error("no_asset");
        if (mode === "text") {
          return await yoloeApi.textPredict(assetId, {
            prompts: textValidRows.map((r) => ({
              class_id: r.classId,
              prompt: r.prompt.trim(),
            })),
            conf,
            iou,
            overwrite,
            output_kind: outputKind,
          });
        }
        if (mode === "visual") {
          const groups = buildVisualGroups();
          if (!groups) throw new Error("no_visual_reference");
          // refer_b64 omitted — api uses the target asset's bytes as
          // the reference (Ultralytics "same image as reference").
          return await yoloeApi.visualPredict(assetId, {
            groups,
            conf,
            iou,
            overwrite,
            output_kind: outputKind,
          });
        }
        return await yoloeApi.promptFreePredict(assetId, {
          annotate_as_class_id: pfClassId || null,
          conf,
          iou,
          max_detections: pfMaxDet || null,
          overwrite,
          output_kind: outputKind,
        });
      }
      // Batch path — enqueue + return job_id (caller renders progress)
      if (!taskId) throw new Error("no_task");
      let params: Record<string, unknown> = {};
      if (mode === "text") {
        params = {
          prompts: textValidRows.map((r) => ({
            class_id: r.classId,
            prompt: r.prompt.trim(),
          })),
          conf,
          iou,
        };
      } else if (mode === "visual") {
        const groups = buildVisualGroups();
        if (!groups) throw new Error("no_visual_reference");
        if (!assetId) throw new Error("no_asset");
        // The user picked refs on the current asset, so that asset
        // is the visual reference. Worker fetches its bytes from
        // MinIO once before the per-asset loop.
        params = {
          refer_asset_id: assetId,
          groups,
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
        output_kind: outputKind,
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
      const created =
        (data as { annotations_created?: number }).annotations_created ?? 0;
      const skipped =
        (data as { skipped_count?: number }).skipped_count ?? 0;
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
        "hover:shadow-[0_0_0_1px_var(--accent)] hover:scale-[1.02]",
        "active:opacity-60 active:scale-100",
      )}
    >
      <ScanEye className="h-3.5 w-3.5 text-[color:var(--accent)]" />
      <span>YOLOE</span>
    </button>
  );

  // v3.23 polish — when the model service has confirmed YOLOE isn't
  // available, hide the toolbar trigger entirely instead of showing a
  // button that opens an "unavailable" dialog. Mirrors the SAM toolbar
  // pattern: features only appear when they're actually ready. The
  // first-render flash (before the status query resolves) is the empty
  // string render below — fine for ~50ms.
  if (statusQ.isFetched && !available) return null;

  // Help text when one or more modes are disabled because their checkpoint
  // isn't shipped (e.g. only the PF model is on disk).
  const someModeDisabled =
    statusQ.isFetched && (!textAvailable || !pfAvailable);
  const modeDisabledHelp = (() => {
    if (!someModeDisabled) return null;
    const missing: string[] = [];
    if (!textAvailable) missing.push("Text & Visual modes need yoloe-26l-seg.pt");
    if (!pfAvailable) missing.push("Prompt-Free mode needs yoloe-26l-seg-pf.pt");
    return missing.join(" · ");
  })();

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) resetState();
      }}
    >
      <DialogTrigger asChild>{trigger ?? fallbackTrigger}</DialogTrigger>
      <DialogContent
        data-testid="yoloe-dialog"
        className="max-w-[680px] grid gap-3"
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
            Detect &amp; segment open-vocabulary objects via text, visual
            examples, or YOLOE&#39;s 4585-class auto-vocabulary.
          </DialogDescription>
        </DialogHeader>

        {!available && statusQ.isFetched ? (
          <div
            data-testid="yoloe-unavailable"
            className="grid gap-2 p-4 rounded-[var(--radius-md)] border border-[var(--warning)]/40 bg-[var(--warning)]/10 text-[12.5px]"
          >
            <div className="flex items-start gap-2">
              <AlertTriangle
                className="h-4 w-4 mt-0.5 text-[color:var(--warning)] shrink-0"
                aria-hidden
              />
              <div>
                <div className="font-medium">
                  YOLOE is not available on this server.
                </div>
                <div className="text-[color:var(--text-secondary)]">
                  Place the checkpoints under{" "}
                  <code className="font-mono">YOLOE_WEIGHTS_DIR</code> (default{" "}
                  <code className="font-mono">/app/weights/yoloe</code>) and
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
              const failed = final?.failed ?? 0;
              const skipped = final?.total_skipped_detections ?? 0;
              const status = final?.status ?? "completed";
              const tail = skipped > 0 ? ` · skipped ${skipped}` : "";
              if (status === "canceled") {
                showToast(
                  `YOLOE batch canceled. Kept ${created} annotation${created === 1 ? "" : "s"} created so far${tail}.`,
                  { variant: "warning", duration: 5000 },
                );
              } else if (status === "failed") {
                showToast(
                  `YOLOE batch failed${created > 0 ? ` after creating ${created} annotation${created === 1 ? "" : "s"}` : ""}.`,
                  { variant: "error", duration: 5000 },
                );
              } else if (status === "completed_with_errors") {
                showToast(
                  `YOLOE batch finished with errors. Created ${created} annotation${created === 1 ? "" : "s"}; ${failed} asset${failed === 1 ? "" : "s"} failed${tail}.`,
                  { variant: "warning", duration: 6000 },
                );
              } else {
                showToast(
                  `YOLOE batch created ${created} annotation${created === 1 ? "" : "s"}${tail}.`,
                  {
                    variant: created > 0 ? "success" : "warning",
                    duration: 6000,
                  },
                );
              }
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
              showToast(
                "Running in background — progress shown bottom-right.",
                { variant: "info", duration: 3000 },
              );
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
                    title={dis ? "Checkpoint not installed" : undefined}
                    className={cn(
                      "flex flex-col items-start gap-0.5 px-3 py-2 rounded-[var(--radius-sm)]",
                      "text-left transition-all duration-[160ms]",
                      active
                        ? "bg-[var(--bg-elev)] shadow-[0_0_0_1px_var(--accent)] scale-[1.02]"
                        : "hover:bg-[var(--bg-hover)] hover:shadow-[0_0_0_1px_var(--border-subtle)]",
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
            {modeDisabledHelp && (
              <p
                data-testid="yoloe-mode-help"
                className="text-[10.5px] text-[color:var(--text-tertiary)] -mt-1 ml-1"
              >
                {modeDisabledHelp}
              </p>
            )}

            {/* Mode-specific body */}
            {mode === "text" && (
              <div className="grid gap-2">
                <div className="flex items-center justify-between">
                  <label className="text-[12px] font-medium text-[color:var(--text-primary)]">
                    Class &amp; prompt rows
                  </label>
                  <span className="text-[10.5px] text-[color:var(--text-tertiary)] font-mono tabular-nums">
                    {textValidRows.length}/{textRows.length} ready
                  </span>
                </div>
                <div className="grid gap-1.5">
                  {textRows.map((row) => {
                    const cls = classes.find((c) => c.id === row.classId);
                    const ready = !!row.classId && row.prompt.trim().length > 0;
                    return (
                      <div
                        key={row.rid}
                        data-testid={`yoloe-text-row-${row.rid}`}
                        className={cn(
                          "grid grid-cols-[180px_1fr_28px] gap-1.5 items-center",
                          "p-1.5 rounded-[var(--radius-md)] border bg-[var(--bg-elev)]",
                          ready
                            ? "border-[var(--border-subtle)]"
                            : "border-[var(--border-subtle)]/60",
                        )}
                      >
                        <div className="flex items-center gap-1.5 min-w-0">
                          <span
                            className="h-2.5 w-2.5 rounded-sm shrink-0 ring-1 ring-black/10"
                            style={{
                              backgroundColor: cls?.color ?? "var(--bg-subtle)",
                            }}
                            aria-hidden
                          />
                          <select
                            value={row.classId}
                            onChange={(e) =>
                              patchTextRow(row.rid, { classId: e.target.value })
                            }
                            data-testid={`yoloe-text-class-${row.rid}`}
                            className="flex-1 min-w-0 h-8 px-2 rounded-[var(--radius-sm)] bg-transparent text-[12px] outline-none focus:bg-[var(--bg-hover)]"
                          >
                            <option value="">Pick class…</option>
                            {classes.map((c) => (
                              <option key={c.id} value={c.id}>
                                {c.name}
                              </option>
                            ))}
                          </select>
                        </div>
                        <input
                          value={row.prompt}
                          onChange={(e) =>
                            patchTextRow(row.rid, { prompt: e.target.value })
                          }
                          placeholder={
                            cls
                              ? `Describe a ${cls.name.toLowerCase()}…`
                              : "Describe what to detect…"
                          }
                          data-testid={`yoloe-text-prompt-${row.rid}`}
                          className="h-8 px-2.5 rounded-[var(--radius-sm)] bg-transparent text-[12px] outline-none focus:bg-[var(--bg-hover)] min-w-0"
                        />
                        <button
                          type="button"
                          onClick={() => removeTextRow(row.rid)}
                          disabled={textRows.length === 1}
                          aria-label="Remove row"
                          data-testid={`yoloe-text-remove-${row.rid}`}
                          className={cn(
                            "h-7 w-7 grid place-items-center rounded-[var(--radius-sm)]",
                            "text-[color:var(--text-tertiary)] hover:text-[color:var(--text-primary)]",
                            "hover:bg-[var(--bg-hover)]",
                            "disabled:opacity-30 disabled:cursor-not-allowed",
                            "transition-colors duration-[140ms]",
                          )}
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    );
                  })}
                </div>
                <button
                  type="button"
                  onClick={addTextRow}
                  data-testid="yoloe-text-add-row"
                  className={cn(
                    "self-start inline-flex items-center gap-1 h-7 px-2 rounded-[var(--radius-sm)]",
                    "text-[11.5px] text-[color:var(--accent)] font-medium",
                    "border border-dashed border-[color:var(--accent)]/40",
                    "transition-all duration-[160ms]",
                    "hover:bg-[var(--accent)]/10 hover:border-[color:var(--accent)]",
                  )}
                >
                  <Plus className="h-3.5 w-3.5" />
                  Add another class + prompt
                </button>
                <p className="text-[10.5px] text-[color:var(--text-tertiary)]">
                  Pick a project class, then write a YOLOE prompt that describes
                  it (e.g.{" "}
                  <span className="font-mono">person wearing hard hat</span>).
                  Each row targets one class — multiple rows run in a single
                  pass.
                </p>
              </div>
            )}

            {mode === "visual" && (
              <div className="grid gap-2">
                <div className="flex items-center justify-between">
                  <label className="text-[12px] font-medium text-[color:var(--text-primary)]">
                    Pick reference{Object.keys(visualAssign).length === 1 ? "" : "s"}{" "}
                    &amp; assign a class to each
                  </label>
                  <span className="text-[10.5px] text-[color:var(--text-tertiary)] font-mono tabular-nums">
                    {Object.keys(visualAssign).length}/{visualReferences.length}{" "}
                    picked · {visualGroupsCount} class
                    {visualGroupsCount === 1 ? "" : "es"}
                  </span>
                </div>
                {visualReferences.length === 0 ? (
                  <div className="grid gap-2 p-3 rounded-[var(--radius-md)] border border-dashed border-[var(--border-subtle)] bg-[var(--bg-subtle)]">
                    <div className="flex items-start gap-2 text-[12px] text-[color:var(--text-secondary)]">
                      <Wand2
                        className="h-4 w-4 mt-0.5 text-[color:var(--accent)]"
                        aria-hidden
                      />
                      <div>
                        <div className="font-medium text-[color:var(--text-primary)]">
                          No bbox or polygon to use as reference yet.
                        </div>
                        <div>
                          Draw one with the bbox or polygon tool (or use SAM)
                          on this asset, then re-open YOLOE in Visual mode.
                        </div>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div
                    className="grid gap-1 max-h-[220px] overflow-y-auto p-1 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-elev)]"
                    data-testid="yoloe-visual-refs"
                  >
                    {visualReferences.map((r) => {
                      const picked = r.id in visualAssign;
                      const assignedCid = visualAssign[r.id] ?? "";
                      const assignedCls = classes.find(
                        (c) => c.id === assignedCid,
                      );
                      const w = Math.round(r.xyxy[2] - r.xyxy[0]);
                      const h = Math.round(r.xyxy[3] - r.xyxy[1]);
                      return (
                        <div
                          key={r.id}
                          data-testid={`yoloe-visual-ref-${r.id}`}
                          className={cn(
                            "grid grid-cols-[20px_minmax(0,1fr)_minmax(0,180px)_auto] gap-2 items-center px-2 py-1.5 rounded-[var(--radius-sm)]",
                            "transition-all duration-[140ms]",
                            picked
                              ? "bg-[var(--accent)]/8 shadow-[0_0_0_1px_var(--accent)]"
                              : "hover:bg-[var(--bg-hover)]",
                          )}
                        >
                          <button
                            type="button"
                            onClick={() => toggleVisual(r.id)}
                            aria-pressed={picked}
                            aria-label={picked ? "Unpick reference" : "Pick reference"}
                            className={cn(
                              "h-4 w-4 rounded-sm border grid place-items-center",
                              "transition-all duration-[140ms]",
                              picked
                                ? "bg-[var(--accent)] border-[var(--accent)]"
                                : "border-[var(--border-subtle)] hover:border-[color:var(--accent)]",
                            )}
                          >
                            {picked && (
                              <CheckCircle2
                                className="h-3 w-3 text-white"
                                strokeWidth={3}
                              />
                            )}
                          </button>
                          <button
                            type="button"
                            onClick={() => toggleVisual(r.id)}
                            className="flex items-center gap-1.5 min-w-0 text-left"
                          >
                            <span
                              className="h-2.5 w-2.5 rounded-sm shrink-0 ring-1 ring-black/10"
                              style={{ backgroundColor: r.color }}
                              aria-hidden
                            />
                            <span className="text-[12px] truncate">
                              {r.className}
                            </span>
                            <span className="text-[10px] font-mono text-[color:var(--text-tertiary)] tabular-nums">
                              {r.sourceKind} · {w}×{h}
                            </span>
                          </button>
                          {picked ? (
                            <div className="flex items-center gap-1 min-w-0">
                              <span className="text-[10.5px] text-[color:var(--text-tertiary)] shrink-0">
                                →
                              </span>
                              <select
                                value={assignedCid}
                                onChange={(e) =>
                                  setVisualClass(r.id, e.target.value)
                                }
                                data-testid={`yoloe-visual-assign-${r.id}`}
                                className={cn(
                                  "flex-1 min-w-0 h-7 px-1.5 rounded-[var(--radius-sm)] text-[11.5px]",
                                  "bg-transparent outline-none",
                                  assignedCid
                                    ? "text-[color:var(--text-primary)]"
                                    : "text-[color:var(--danger,#d4504a)]",
                                  "hover:bg-[var(--bg-hover)]",
                                )}
                              >
                                <option value="">Pick class *</option>
                                {classes.map((c) => (
                                  <option key={c.id} value={c.id}>
                                    {c.name}
                                  </option>
                                ))}
                              </select>
                            </div>
                          ) : (
                            <span className="text-[10.5px] text-[color:var(--text-tertiary)] italic">
                              not picked
                            </span>
                          )}
                          <span
                            className="h-2.5 w-2.5 rounded-full shrink-0"
                            style={{
                              backgroundColor: assignedCls?.color ?? "transparent",
                              border: assignedCls
                                ? "none"
                                : "1px dashed var(--border-subtle)",
                            }}
                            aria-hidden
                            title={
                              assignedCls
                                ? `Matches saved as ${assignedCls.name}`
                                : "No class assigned yet"
                            }
                          />
                        </div>
                      );
                    })}
                  </div>
                )}
                <p className="text-[10.5px] text-[color:var(--text-tertiary)]">
                  Pick one or more bbox/polygon refs and assign each to a
                  project class. YOLOE finds visually similar objects across
                  the target asset(s); refs sharing a class strengthen its
                  visual signature.
                </p>
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
                  <option value="">
                    Auto-map detected classes by name (skip unmatched)
                  </option>
                  {classes.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
                <label className="text-[12px] font-medium text-[color:var(--text-primary)] mt-1">
                  Max detections per image
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
                <p className="text-[10.5px] text-[color:var(--text-tertiary)]">
                  Busy scenes can exceed 100 detections — increase if YOLOE
                  is missing objects.
                </p>
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
                      title={
                        dis ? "Open inside a task to enable" : undefined
                      }
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
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
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
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={iou}
                    onChange={(e) => setIou(Number(e.target.value))}
                    className="w-full"
                    data-testid="yoloe-iou"
                  />
                </label>
              </div>

              {/* Output type — YOLOE-seg returns both bbox + mask polygon
                  per detection. Pick ONE so each object becomes one
                  annotation (not a stacked pair). */}
              <div className="grid gap-1">
                <span className="text-[11px] text-[color:var(--text-secondary)]">
                  Save detections as
                </span>
                <div className="grid grid-cols-2 gap-1 p-1 rounded-[var(--radius-md)] bg-[var(--bg-subtle)]">
                  {(
                    [
                      { v: "polygon" as const, label: "Polygon", sub: "Instance mask" },
                      { v: "bbox" as const, label: "Box", sub: "Bounding rectangle" },
                    ]
                  ).map((opt) => {
                    const active = outputKind === opt.v;
                    return (
                      <button
                        key={opt.v}
                        type="button"
                        onClick={() => setOutputKind(opt.v)}
                        data-testid={`yoloe-output-${opt.v}`}
                        className={cn(
                          "flex flex-col items-start gap-0 px-3 py-1.5 rounded-[var(--radius-sm)]",
                          "text-left transition-all duration-[140ms]",
                          active
                            ? "bg-[var(--bg-elev)] shadow-[0_0_0_1px_var(--accent)]"
                            : "hover:bg-[var(--bg-hover)]",
                        )}
                      >
                        <span className="text-[12px] font-medium">
                          {opt.label}
                        </span>
                        <span className="text-[10px] text-[color:var(--text-tertiary)]">
                          {opt.sub}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>

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
                title={
                  !canRun && mode === "visual" && Object.keys(visualAssign).length > 0
                    ? "Every picked reference needs a class assigned"
                    : !canRun && mode === "text" && textValidRows.length === 0
                      ? "Add at least one row with both a class and a prompt"
                      : undefined
                }
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
  // Track when the dialog opened so we can flag a stuck-pending state.
  // The poll re-renders ~600 ms; ``Date.now() - openedAt`` becomes
  // accurate by simply re-deriving on each render.
  const [openedAt] = useState(() => Date.now());
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setTick((t) => t + 1), 1000);
    return () => window.clearInterval(id);
  }, []);
  void tick; // tick exists only to force re-renders for elapsed math
  const POLL_MS = 600;
  const q = useQuery({
    queryKey: ["yoloe-batch", taskId, jobId],
    queryFn: () => yoloeApi.pollBatch(taskId, jobId),
    refetchInterval: (qq) => {
      const s = qq.state.data?.status;
      if (
        s === "completed" ||
        s === "completed_with_errors" ||
        s === "failed" ||
        s === "canceled"
      ) {
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
  // Stuck-pending heuristic: if the worker hasn't bumped ``total``
  // off zero and 15 s have passed, surface a hint. Init_progress
  // (worker side) sets ``total`` within ~1 s of pickup, so 15 s
  // means the worker is dead, the rq queue is full, or the model
  // service is hosed.
  const elapsedMs = Date.now() - openedAt;
  const isStuck =
    !isTerminal && total === 0 && status === "pending" && elapsedMs > 15000;

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
      {isStuck && (
        <div
          data-testid="yoloe-batch-stuck-hint"
          className="flex items-start gap-1.5 text-[10.5px] text-[color:var(--warning,#d49a4a)]"
        >
          <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" aria-hidden />
          <span>
            Worker hasn't started yet. Confirm the worker container is
            up and hasn't crashed (
            <span className="font-mono">docker compose logs worker</span>
            ); cancel here is safe.
          </span>
        </div>
      )}
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
              } catch (err) {
                setCanceling(false);
                showToast(
                  `Cancel failed: ${
                    err instanceof Error ? err.message : "unknown"
                  }. Retry?`,
                  { variant: "error", duration: 4000 },
                );
                return;
              }
              // v3.23.5 — optimistic close. The server has been told
              // to cancel; the worker (if running) will break out
              // between assets and finalize as canceled. Don't make
              // the user click Done after Cancel — close immediately
              // with whatever counts the last poll captured.
              onClose({
                total_annotations_created:
                  data?.total_annotations_created ?? 0,
                total_skipped_detections:
                  data?.total_skipped_detections ?? 0,
                failed: data?.failed ?? 0,
                status: "canceled",
              });
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
