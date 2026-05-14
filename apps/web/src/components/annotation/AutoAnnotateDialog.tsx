// Armin Mehri — mehri.armin@gmail.com
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Loader2, Plus, Search, Wand2, X } from "lucide-react";

import {
  samApi,
  type SamAutoVisualBody,
  type SamVisualRef,
  type SamVisualSource,
} from "@/api/sam";
import { modelsApi } from "@/api/phase2";
import { classesApi, type ClassRow } from "@/api/classes";
import { Input } from "@/components/ui/Input";
import {
  VisualReferencePicker,
  type VisualPick,
} from "@/components/annotation/VisualReferencePicker";
import { useTaskRefs } from "@/state/useTaskRefs";
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
import { ensureSamReady } from "@/lib/samConvert";
import { inferenceErrorMessage } from "@/lib/inferenceErrors";
import { useBackgroundJobs } from "@/state/backgroundJobs";
import { useDialogPrefs } from "@/state/dialogPrefs";

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
  // v3.28 — top-level dialog mode. Visual tab is gated by the model
  // service's ``visual_prompt_available`` capability flag; when it's
  // false the tab switcher is hidden and the dialog renders the Text
  // body only (no UX regression for SAM 2 / SAM 3-transformers users).
  const [mode, setMode] = useState<"text" | "visual">("text");
  // v3.30 — visible "Loading SAM…" state while the Run mutation is
  // waiting for the predictor to come online. Driven by
  // ``ensureSamReady`` inside the mutationFn.
  const [samLoadingForRun, setSamLoadingForRun] = useState(false);
  // v3.30 — inline class+prompt rows, matching Smart Find. Each row
  // pairs a project class with a YOLOE/SAM-text prompt the user can
  // edit at run time. Dirty rows are persisted via classesApi.update
  // right before the run so the next session sees them too.
  interface TextRow {
    rid: string;
    classId: string;
    prompt: string;
    /** Original prompt at the time the row was seeded; used to compute
     *  whether a save is needed before submit. */
    initialPrompt: string;
  }
  const [textRows, setTextRows] = useState<TextRow[]>([]);
  // Search filter for the row list. Hidden until >6 rows so small
  // projects don't see unnecessary chrome.
  const [textRowQuery, setTextRowQuery] = useState("");
  // SAM 3 (transformers) and SAM 3.1 (native) emit detection scores
  // whose useful range lands around 0.20–0.60 for most concepts. The
  // legacy 0.40 default left too many obvious objects below the floor;
  // 0.30 is a better OOTB compromise. Users can still slide either way.
  const [threshold, setThreshold] = useState<number>(0.3);
  // Bbox-IoU floor for the server-side NMS dedup pass. Matches the
  // server's _NMS_IOU_THRESHOLD default. Lower = more aggressive dedup
  // (collapses anything with meaningful overlap); higher = only true
  // near-duplicates collapse; 1.0 effectively disables NMS.
  const [iouThreshold, setIouThreshold] = useState<number>(0.7);
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
  // v3.28 — parallel slot for the SAM Visual Prompt batch. Lifted to the
  // dialog scope (not VisualBody) so the parent's onOpenChange can
  // redirect outside-click closes to "background" without orphaning the
  // job, and so the expand-from-bar handshake can target it.
  const [visualRunningJobId, setVisualRunningJobId] = useState<string | null>(
    null,
  );
  // v3.22 — refs for the post-process AbortController + job_id so the
  // BatchProgressView's Cancel/Background buttons can address the
  // post-process phase (Promise-based, frontend-driven runner).
  const postAbortRef = useRef<AbortController | null>(null);
  const postJobIdRef = useRef<string | null>(null);

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
    // v3.22 fix — only claim SAM auto-text jobs. Without this filter
    // both this dialog AND the YOLO BatchPredictProgressOverlay's
    // listener match every expand request, racing each other to
    // ``remove()`` + ``clearExpandRequest()``. Symptom: clicking
    // Expand on a YOLO job opened the SAM dialog with stale state
    // ("the dialog is bigger"), and the next Background click hit
    // the wrong handler.
    // v3.28 — claim sam-auto-text AND sam-auto-visual; the dialog body
    // switches to the right body via the ``mode`` state which we also
    // flip here based on the job kind.
    if (job.kind !== "sam-auto-text" && job.kind !== "sam-auto-visual") return;
    if (job.kind === "sam-auto-visual") {
      setMode("visual");
      setVisualRunningJobId(bgExpandRequest);
    } else {
      setRunningJobId(bgExpandRequest);
    }
    setOpen(true);
    // Defer store cleanup to a microtask so React's state batching
    // commits ``runningJobId`` + ``open`` before any subscriber sees
    // ``bgJobs`` change. Without the defer, Zustand's synchronous
    // notify could trigger a tear-down render between the two
    // setStates.
    queueMicrotask(() => {
      useBackgroundJobs.getState().remove(bgExpandRequest);
      useBackgroundJobs.getState().clearExpandRequest();
    });
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

  // v3.30 — hydrate from persisted per-task prefs when the dialog
  // opens. Falls back to seeding from the project's saved class
  // prompts (the legacy behaviour) so users who never ran a task
  // still see something useful on first open. Closed-state edits
  // from elsewhere are reflected because the seed re-runs each
  // open.
  const dialogPrefs = useDialogPrefs();
  useEffect(() => {
    if (!open) return;
    const stored = dialogPrefs.getAutoAnnotate(taskId)?.text;
    if (stored && stored.rows.length > 0) {
      // Reconcile stored rows against the current class set in case
      // a class was deleted between sessions.
      const classIds = new Set(classes.map((c) => c.id));
      const restored: TextRow[] = stored.rows
        .filter((r) => !r.classId || classIds.has(r.classId))
        .map((r, i) => ({
          rid: `pref-${i}-${r.classId || "empty"}`,
          classId: r.classId,
          prompt: r.prompt,
          initialPrompt:
            classes.find((c) => c.id === r.classId)?.text_prompt ?? r.prompt,
        }));
      if (restored.length === 0) {
        restored.push({
          rid: `r-${Date.now()}`,
          classId: "",
          prompt: "",
          initialPrompt: "",
        });
      }
      setTextRows(restored);
      setThreshold(stored.threshold);
      // Optional in the persisted shape — older entries that pre-date
      // the IoU slider fall back to the server's default (0.70).
      setIouThreshold(stored.iouThreshold ?? 0.7);
      setFindAll(stored.findAll);
      setOverwrite(stored.overwrite);
      setSamPostMode(stored.samPostMode);
      setScope(stored.scope);
      setUseVlmFo1(stored.useVlmFo1);
    } else {
      const seeded: TextRow[] = classes
        .filter((c) => (c.text_prompt ?? "").trim().length > 0)
        .map((c) => ({
          rid: `seed-${c.id}`,
          classId: c.id,
          prompt: c.text_prompt ?? "",
          initialPrompt: c.text_prompt ?? "",
        }));
      if (seeded.length === 0) {
        seeded.push({
          rid: `r-${Date.now()}`,
          classId: "",
          prompt: "",
          initialPrompt: "",
        });
      }
      setTextRows(seeded);
    }
    setTextRowQuery("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // v3.30 — write current state back to per-task prefs whenever the
  // user edits anything while the dialog is open. Static getState
  // avoids re-binding the effect on every render of the store.
  useEffect(() => {
    if (!open) return;
    useDialogPrefs.getState().saveAutoAnnotate(taskId, {
      text: {
        rows: textRows.map((r) => ({ classId: r.classId, prompt: r.prompt })),
        threshold,
        iouThreshold,
        findAll,
        overwrite,
        samPostMode,
        scope,
        useVlmFo1,
      },
    });
  }, [
    open,
    taskId,
    textRows,
    threshold,
    iouThreshold,
    findAll,
    overwrite,
    samPostMode,
    scope,
    useVlmFo1,
  ]);

  // Reset everything for this task back to defaults — both in-memory
  // state and the persisted entry. The user picks this when they want
  // a fresh start.
  function clearForThisTask() {
    useDialogPrefs.getState().clearAutoAnnotate(taskId);
    setTextRows([
      { rid: `r-${Date.now()}`, classId: "", prompt: "", initialPrompt: "" },
    ]);
    setTextRowQuery("");
    setThreshold(0.4);
    setIouThreshold(0.7);
    setFindAll(true);
    setOverwrite(false);
    setSamPostMode("off");
    setScope("this");
    setUseVlmFo1(false);
  }

  // Selection is derived: any row with a class and a non-empty prompt
  // counts as selected for the run.
  const validTextRows = useMemo(
    () => textRows.filter((r) => r.classId && r.prompt.trim().length > 0),
    [textRows],
  );

  const classById = useMemo(() => {
    const m = new Map<string, ClassRow>();
    for (const c of classes) m.set(c.id, c);
    return m;
  }, [classes]);

  const visibleTextRows = useMemo(() => {
    const q = textRowQuery.trim().toLowerCase();
    if (!q) return textRows;
    return textRows.filter((r) => {
      const name = classById.get(r.classId)?.name.toLowerCase() ?? "";
      return name.includes(q) || r.prompt.toLowerCase().includes(q);
    });
  }, [textRows, textRowQuery, classById]);

  function patchTextRow(rid: string, patch: Partial<TextRow>) {
    setTextRows((prev) =>
      prev.map((r) => {
        if (r.rid !== rid) return r;
        const next = { ...r, ...patch };
        // When the user picks a DIFFERENT class via the dropdown, the
        // row's "initial" prompt — which the dirty indicator and the
        // save-on-Run gate compare against — must rebind to the new
        // class's stored text_prompt. Without this, swapping shirts
        // (text_prompt="pants") → helmet (text_prompt="") left
        // initialPrompt stuck at "pants", the dirty check returned
        // false, no PATCH fired, the server saw helmet.text_prompt=""
        // and rejected the run with no_eligible_classes (or silently
        // skipped helmet in a multi-class run).
        if (patch.classId !== undefined && patch.classId !== r.classId) {
          next.initialPrompt = classById.get(patch.classId)?.text_prompt ?? "";
        }
        return next;
      }),
    );
  }
  function addTextRow() {
    setTextRows((prev) => [
      ...prev,
      {
        rid: `r-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        classId: "",
        prompt: "",
        initialPrompt: "",
      },
    ]);
  }
  function removeTextRow(rid: string) {
    setTextRows((prev) => {
      if (prev.length === 1) return prev;
      return prev.filter((r) => r.rid !== rid);
    });
  }

  // v3.21+ — capability gate: hide the FO1 toggle when the model
  // service isn't advertising it. Only fetched while the dialog is open.
  // v3.28 — staleTime dropped from 30s → 0 + refetchOnMount: "always"
  // because variant switches can flip visual_prompt_available within the
  // same browser session; the previous 30s stale window left users
  // staring at a hidden Visual tab right after switching to SAM 3.1.
  const samStatusQuery = useQuery({
    queryKey: ["sam", "status", "vlm-fo1-cap"],
    queryFn: () => modelsApi.samStatus(),
    enabled: open,
    refetchOnWindowFocus: false,
    refetchOnMount: "always",
    staleTime: 0,
  });
  // FO1 only makes sense on SAM 3 family variants. v3.28 — include
  // "sam3.1" in the family check; the previous strict ``=== "sam3"``
  // broke the FO1 toggle visibility when the user switched to native.
  const samVariant = samStatusQuery.data?.variant ?? "";
  const isSam3Family = samVariant === "sam3" || samVariant === "sam3.1";
  const vlmFo1Available =
    samStatusQuery.data?.vlm_fo1_available === true && isSam3Family;
  // v3.28 — SAM Visual Prompt capability gate. Hidden when the model
  // service does not advertise a visual-prompt runtime; preserves the
  // single-tab Text UX on SAM 2 / SAM 3-transformers deployments.
  const visualPromptAvailable =
    samStatusQuery.data?.visual_prompt_available === true;
  // Reset to "text" whenever the dialog closes, and clamp to "text" if
  // the capability disappears mid-session.
  useEffect(() => {
    if (!open) {
      setMode("text");
    } else if (!visualPromptAvailable && mode === "visual") {
      setMode("text");
    }
  }, [open, visualPromptAvailable, mode]);

  // v3.22 — no longer seed from per-user pref. The toggle starts OFF
  // each time the dialog opens (see useState above). Existing per-user
  // pref rows on the server are intentionally ignored; the API
  // endpoints are kept around for backwards compatibility with older
  // clients but this dialog no longer reads or writes them.

  const run = useMutation({
    mutationFn: async () => {
      // v3.30 — persist any row whose prompt was edited inline before
      // we kick off the run, so the saved per-class prompts stay in
      // sync with what the user just submitted. We collect a project
      // id from the first valid row's class (every class on a project
      // shares the same project_id by construction).
      const projectId =
        validTextRows.length > 0
          ? classById.get(validTextRows[0].classId)?.project_id
          : undefined;
      if (projectId) {
        // Compare against the LIVE class.text_prompt (not the row's
        // captured initialPrompt) so a stale or carried-over
        // initialPrompt — e.g. from swapping classes via the dropdown
        // — can't make us skip a needed save. If the user's typed
        // prompt diverges from what the server currently has for
        // that class, we PATCH; otherwise we skip the no-op write.
        const toSave = validTextRows.filter((r) => {
          const stored = (classById.get(r.classId)?.text_prompt ?? "").trim();
          return r.prompt.trim() !== stored;
        });
        if (toSave.length > 0) {
          await Promise.all(
            toSave.map((r) =>
              classesApi.update(projectId, r.classId, {
                text_prompt: r.prompt.trim(),
              }),
            ),
          );
          // Refresh the classes list so the dialog (and the editor's
          // ClassesPanel) reflect the saved prompts.
          qc.invalidateQueries({ queryKey: ["classes", projectId] });
        }
      }
      const runClassIds = validTextRows.map((r) => r.classId);
      // v3.30 — pre-flight SAM load. The backend lazy-loads on first
      // request, but the load can take 5-30 s; without this guard the
      // first Run after a cold start 503s and the user has to retry.
      // Idempotent + cheap when SAM is already ready.
      setSamLoadingForRun(true);
      try {
        await ensureSamReady();
      } finally {
        setSamLoadingForRun(false);
      }
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
          class_ids: runClassIds,
          threshold,
          find_all: findAll,
          overwrite,
          iou_threshold: iouThreshold,
          ...(wireUseVlmFo1 ? { use_vlm_fo1: true } : {}),
        });
        return { kind: "batch", job_id: r.job_id } as const;
      }
      if (!assetId) throw new Error("no_asset");
      const r = await samApi.autoText(assetId, {
        class_ids: runClassIds,
        threshold,
        find_all: findAll,
        overwrite,
        iou_threshold: iouThreshold,
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
      // Prefer the structured admission-aware mapper so GPU OOM and
      // GPU-busy 503s surface their own messages (with free/needed MB
      // when available) instead of a flat "Auto-annotate failed."
      const friendly = inferenceErrorMessage(err);
      let message = friendly ?? "Auto-annotate failed.";
      if (friendly === null) {
        if (detail === "sam3_not_enabled") {
          message = "Auto-annotate needs SAM 3. Switch in Settings -> Models.";
        } else if (detail === "no_eligible_classes") {
          message = "Selected classes have no text prompt.";
        }
      }
      showToast(message, { variant: "error", duration: 5000 });
    },
  });

  // v3.30 — Run is gated on the derived row state. ``selectedClassIds``
  // remains in scope for older callers but isn't part of the gate.
  const canRun =
    validTextRows.length > 0 &&
    !run.isPending &&
    ((scope === "this" && !!assetId) ||
      (scope === "all" && !!taskId));

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        // v3.28 — outside-click / ESC / X close while a batch is running
        // must NOT orphan the job (mirrors the YoloeDialog guard). The
        // user has three intents in this state: Cancel (explicit), move
        // it offscreen (Background button), or close (implicit). The
        // implicit case used to silently drop the polling overlay; now
        // we treat it as "background" so the floating bar takes over.
        if (!o && visualRunningJobId && taskId) {
          const jobId = visualRunningJobId;
          const cap = taskId;
          useBackgroundJobs.getState().add({
            jobId,
            taskId: cap,
            kind: "sam-auto-visual",
            label: "SAM visual prompt",
            startedAt: Date.now(),
            cancel: async () => {
              await samApi.autoVisualBatchCancel(cap, jobId);
            },
          });
          setVisualRunningJobId(null);
          setOpen(false);
          showToast(
            "Running in background — progress shown bottom-right.",
            { variant: "info", duration: 3000 },
          );
          return;
        }
        setOpen(o);
      }}
    >
      <DialogTrigger asChild>
        {trigger ?? (
          <button
            type="button"
            data-testid="auto-annotate-trigger"
            disabled={!assetId}
            className={cn(
              // DESIGN.md §4 — primary CTA pill: PS Blue at rest.
              // v3.24.12 — whitespace-nowrap + shrink-0 + label-collapse
              // mirrors the My Model and Smart Find pills so the three
              // primary CTAs degrade together when the toolbar is tight
              // (SAM controls active, narrow viewport).
              "inline-flex h-8 shrink-0 items-center gap-1.5 px-3 rounded-[var(--radius-pill)] whitespace-nowrap",
              "bg-[var(--accent)] text-white text-[12.5px] font-medium tracking-[0.4px]",
              "border border-[var(--accent)]",
              "transition-all duration-[180ms] ease-out",
              "hover:bg-[var(--accent-hover)] hover:border-white",
              "hover:shadow-[0_0_0_2px_var(--accent)] hover:scale-[1.05]",
              "active:opacity-60 active:scale-100",
              "disabled:bg-[var(--bg-subtle)] disabled:border-[var(--border-subtle)] disabled:text-[color:var(--text-tertiary)] disabled:cursor-not-allowed disabled:hover:scale-100 disabled:hover:shadow-none",
            )}
            title="Detect every project class that has a text description"
            aria-label="Auto-Annotate"
          >
            <Wand2 className="h-3.5 w-3.5" />
            <span className="hidden min-[1440px]:inline">Auto-Annotate</span>
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
                // v3.22 — register the post-process as a backgroundable
                // job. The runner is frontend-driven (a Promise in this
                // tab) so cancel = abort controller; the bar reads
                // progress from the store via setProgress.
                const ppJobId =
                  typeof crypto !== "undefined" && crypto.randomUUID
                    ? crypto.randomUUID()
                    : `pp-${Date.now()}-${Math.random()}`;
                const ppController = new AbortController();
                postAbortRef.current = ppController;
                postJobIdRef.current = ppJobId;
                useBackgroundJobs.getState().add({
                  jobId: ppJobId,
                  taskId,
                  kind: "polygon-convert",
                  label: "Convert polygons → bboxes",
                  startedAt: Date.now(),
                  cancel: async () => {
                    ppController.abort();
                  },
                });
                useBackgroundJobs.getState().setProgress(ppJobId, {
                  status: "running",
                  done: 0,
                  total: created,
                  failed: 0,
                });
                void runBatchTaskPostProcess({
                  taskId,
                  sinceIso: startIso,
                  classIds: new Set(validTextRows.map((r) => r.classId)),
                  mode: samPostMode as PostProcessMode,
                  signal: ppController.signal,
                  onProgress: (p) => {
                    setSamPostProgress(p);
                    useBackgroundJobs.getState().setProgress(ppJobId, {
                      status: "running",
                      done: p.done,
                      total: p.total,
                      failed: p.failed,
                    });
                  },
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
                    useBackgroundJobs.getState().setProgress(ppJobId, {
                      status: "completed",
                      done: res.succeeded + res.failed,
                      total: res.succeeded + res.failed,
                      failed: res.failed,
                    });
                  })
                  .catch((err) => {
                    if (ppController.signal.aborted) {
                      useBackgroundJobs.getState().setProgress(ppJobId, {
                        status: "canceled",
                      });
                    } else {
                      showToast("Batch post-process failed.", {
                        variant: "error",
                      });
                      useBackgroundJobs.getState().setProgress(ppJobId, {
                        status: "failed",
                        message: String(err),
                      });
                    }
                  })
                  .finally(() => {
                    setSamPostProgress(null);
                    qc.invalidateQueries({ queryKey: ["annotations"] });
                    qc.invalidateQueries({ queryKey: ["task-assets", taskId] });
                    setRunningJobId(null);
                    setOpen(false);
                    postAbortRef.current = null;
                    postJobIdRef.current = null;
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
                    // over progress polling + cancel UX.
                    const jobId = runningJobId!;
                    const cap = taskId;
                    // Only register the SAM batch if it's still running
                    // — if we're already in post-process phase, the
                    // polygon-convert job is in the store and the SAM
                    // batch is done; re-registering would create a
                    // bogus card.
                    if (!samPostProgress) {
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
                    }
                    // Reset stale state so the next time the dialog
                    // opens (whether via Expand or a fresh run) it
                    // doesn't render leftover post-process progress.
                    setSamPostProgress(null);
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
            {mode === "visual"
              ? "Pick reference annotations from this task and SAM 3.1 will find matching objects."
              : "Run SAM 3 text prompts on the selected classes. Set per-class prompts in the Classes editor."}
          </DialogDescription>
        </DialogHeader>

        {/* v3.28 — Text/Visual tab switcher. Hidden when the model
            service does not advertise a visual-prompt runtime. */}
        {visualPromptAvailable && (
          <div className="grid grid-cols-2 gap-1 p-1 rounded-[var(--radius-md)] bg-[var(--bg-subtle)] mb-3">
            <button
              type="button"
              data-testid="auto-annotate-mode-text"
              onClick={() => setMode("text")}
              aria-pressed={mode === "text"}
              className={cn(
                "flex flex-col items-start gap-0.5 px-3 py-2 rounded-[var(--radius-sm)] text-left transition-all duration-[160ms]",
                mode === "text"
                  ? "bg-[var(--bg-elev)] shadow-[0_0_0_1px_var(--accent)] scale-[1.02]"
                  : "hover:bg-[var(--bg-hover)]",
              )}
            >
              <span className="text-[12px] font-medium">Text Prompt</span>
              <span className="text-[10.5px] text-[color:var(--text-tertiary)]">
                Per-class text concept
              </span>
            </button>
            <button
              type="button"
              data-testid="auto-annotate-mode-visual"
              onClick={() => setMode("visual")}
              aria-pressed={mode === "visual"}
              className={cn(
                "flex flex-col items-start gap-0.5 px-3 py-2 rounded-[var(--radius-sm)] text-left transition-all duration-[160ms]",
                mode === "visual"
                  ? "bg-[var(--bg-elev)] shadow-[0_0_0_1px_var(--accent)] scale-[1.02]"
                  : "hover:bg-[var(--bg-hover)]",
              )}
            >
              <span className="text-[12px] font-medium">Visual Prompt</span>
              <span className="text-[10.5px] text-[color:var(--text-tertiary)]">
                Pick reference annotations
              </span>
            </button>
          </div>
        )}

        {mode === "text" && (
        <>
        {/* Engine */}
        <div className="grid gap-2 mb-4">
          <div className="text-[11px] uppercase tracking-[0.16em] text-[color:var(--text-tertiary)]">
            Engine
          </div>
          <div className="text-[13px] text-[color:var(--text-primary)]">
            SAM 3 Text
          </div>
        </div>

        {/* v3.30 — Class & prompt rows (mirrors Smart Find). Each row
            pairs a project class with the SAM text prompt that drives
            its detection. Edits are persisted to the per-class
            text_prompt on submit so the next session sees them. */}
        <div className="grid gap-2 mb-4">
          <div className="flex items-center justify-between">
            <label className="text-[11px] uppercase tracking-[0.16em] text-[color:var(--text-tertiary)]">
              Class &amp; prompt rows
            </label>
            <span className="text-[10.5px] text-[color:var(--text-tertiary)] font-mono tabular-nums">
              {validTextRows.length}/{textRows.length} ready
            </span>
          </div>
          {textRows.length > 6 && (
            <Input
              type="search"
              value={textRowQuery}
              onChange={(e) => setTextRowQuery(e.target.value)}
              placeholder="Filter rows by class name or prompt…"
              data-testid="auto-annotate-row-search"
              aria-label="Filter rows"
              leftIcon={<Search className="h-3.5 w-3.5" aria-hidden />}
              className="h-7 text-[12px]"
            />
          )}
          {/* Scroll-bound row list — dialog stays a sane height even
              with 80+ classes. */}
          <div className="grid gap-1.5 max-h-[280px] overflow-y-auto pr-1">
            {visibleTextRows.length === 0 && textRowQuery && (
              <p className="px-2 py-2 text-[12px] text-[color:var(--text-tertiary)] italic">
                No rows match "{textRowQuery}".
              </p>
            )}
            {visibleTextRows.map((row) => {
              const cls = classById.get(row.classId);
              const ready =
                !!row.classId && row.prompt.trim().length > 0;
              const dirty =
                row.prompt.trim() !== row.initialPrompt.trim();
              return (
                <div
                  key={row.rid}
                  data-testid={`auto-annotate-text-row-${row.rid}`}
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
                        backgroundColor:
                          cls?.color ?? "var(--bg-subtle)",
                      }}
                      aria-hidden
                    />
                    <select
                      value={row.classId}
                      onChange={(e) =>
                        patchTextRow(row.rid, { classId: e.target.value })
                      }
                      data-testid={`auto-annotate-class-${row.rid}`}
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
                  <div className="relative">
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
                      data-testid={`auto-annotate-prompt-${row.rid}`}
                      className="w-full h-8 px-2.5 pr-12 rounded-[var(--radius-sm)] bg-transparent text-[12px] outline-none focus:bg-[var(--bg-hover)]"
                    />
                    {dirty && (
                      <span
                        title="Unsaved prompt edit — saved on Run"
                        className="absolute right-2 top-1/2 -translate-y-1/2 font-mono text-[9.5px] text-[color:var(--accent)]"
                      >
                        edited
                      </span>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => removeTextRow(row.rid)}
                    disabled={textRows.length === 1}
                    aria-label="Remove row"
                    data-testid={`auto-annotate-remove-${row.rid}`}
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
            data-testid="auto-annotate-add-row"
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
            Pick a project class, then write a SAM-text prompt that
            describes it (e.g. <span className="font-mono">red helmet on a person</span>).
            Edits are saved to the class on Run.
          </p>
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

        {/* IoU threshold (per-class NMS dedup) */}
        <div className="grid gap-2 mb-4">
          <div className="flex items-center justify-between">
            <span className="text-[11px] uppercase tracking-[0.16em] text-[color:var(--text-tertiary)]">
              Overlap (IoU) &ge;
            </span>
            <span className="font-mono text-[12px] text-[color:var(--text-primary)]">
              {iouThreshold >= 1 ? "off" : iouThreshold.toFixed(2)}
            </span>
          </div>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={iouThreshold}
            onChange={(e) => setIouThreshold(parseFloat(e.target.value))}
            data-testid="auto-annotate-iou-threshold"
          />
          <p className="text-[11px] leading-snug text-[color:var(--text-tertiary)]">
            Two detections with bbox-IoU above this are treated as the
            same object and the lower-scored one is dropped. Lower =
            more aggressive dedup. 1.00 turns NMS off.
          </p>
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
          <Button
            variant="ghost"
            size="md"
            onClick={clearForThisTask}
            data-testid="auto-annotate-clear"
            title="Reset rows and settings for this task"
          >
            Clear
          </Button>
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
            {samLoadingForRun ? "Loading SAM…" : "Run"}
          </Button>
        </DialogFooter>
        </>
        )}

        {mode === "visual" && (
          <VisualBody
            runningJobId={visualRunningJobId}
            setRunningJobId={setVisualRunningJobId}
            assetId={assetId}
            taskId={taskId}
            classes={classes}
            onSuccess={onSuccess}
            setOpen={setOpen}
          />
        )}
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

// v3.28 — SAM Visual Prompt body (PCS / Promotable Concept Segmentation).
// Owns its own picks state, ref-kind toggle, scope/threshold/find/overwrite
// controls, and the run mutation. Mounted only when the parent's ``mode``
// is ``visual`` and the model service advertised ``visual_prompt_available``.
function VisualBody({
  assetId,
  taskId,
  classes,
  onSuccess,
  setOpen,
  runningJobId,
  setRunningJobId,
}: {
  assetId: string | null;
  taskId?: string;
  classes: ClassRow[];
  onSuccess?: (n: number) => void;
  setOpen: (o: boolean) => void;
  // v3.28 — lifted to the parent so the dialog's outside-click guard
  // can redirect to "background" instead of orphaning the job.
  runningJobId: string | null;
  setRunningJobId: (id: string | null) => void;
}) {
  const qc = useQueryClient();
  const [refKind, setRefKind] = useState<"bbox" | "polygon">("bbox");
  const [picks, setPicks] = useState<Record<string, VisualPick>>({});
  const [confirmSwitchTo, setConfirmSwitchTo] = useState<
    "bbox" | "polygon" | null
  >(null);
  const [scope, setScope] = useState<"this" | "all">("this");
  const [threshold, setThreshold] = useState<number>(0.4);
  const [findAll, setFindAll] = useState<boolean>(true);
  const [overwrite, setOverwrite] = useState<boolean>(false);

  const refs = useTaskRefs({ taskId, assetId, enabled: true });

  function sendToBackground() {
    if (!runningJobId || !taskId) return;
    const jobId = runningJobId;
    const cap = taskId;
    useBackgroundJobs.getState().add({
      jobId,
      taskId: cap,
      kind: "sam-auto-visual",
      label: "SAM visual prompt",
      startedAt: Date.now(),
      cancel: async () => {
        await samApi.autoVisualBatchCancel(cap, jobId);
      },
    });
    setRunningJobId(null);
    setOpen(false);
    showToast(
      "Running in background — progress shown bottom-right.",
      { variant: "info", duration: 3000 },
    );
  }

  function requestSwitch(next: "bbox" | "polygon") {
    if (next === refKind) return;
    if (Object.keys(picks).length > 0) {
      setConfirmSwitchTo(next);
    } else {
      setRefKind(next);
    }
  }

  function buildSources(): SamVisualSource[] {
    // Group picks by (asset_id, class_id). Each group's ``refs`` is the
    // raw geometry from ``VisualPick`` so SAM 3.1 PCS can use polygon
    // points or bbox xyxy directly.
    const bySource = new Map<string, Map<string, SamVisualRef[]>>();
    for (const p of Object.values(picks)) {
      if (!p.classId) continue;
      const inner = bySource.get(p.assetId) ?? new Map<string, SamVisualRef[]>();
      const list = inner.get(p.classId) ?? [];
      list.push(p.geometry as SamVisualRef);
      inner.set(p.classId, list);
      bySource.set(p.assetId, inner);
    }
    return Array.from(bySource.entries()).map(([asset_id, inner]) => ({
      asset_id,
      groups: Array.from(inner.entries()).map(([class_id, refList]) => ({
        class_id,
        refs: refList,
      })),
    }));
  }

  const summary = useMemo(() => {
    const sources = new Set<string>();
    const classIds = new Set<string>();
    let unassigned = 0;
    for (const p of Object.values(picks)) {
      sources.add(p.assetId);
      if (p.classId) classIds.add(p.classId);
      else unassigned += 1;
    }
    return {
      pickCount: Object.keys(picks).length,
      sourceCount: sources.size,
      classCount: classIds.size,
      unassigned,
    };
  }, [picks]);

  const canRun =
    summary.pickCount > 0 &&
    summary.unassigned === 0 &&
    ((scope === "this" && !!assetId) || (scope === "all" && !!taskId));

  const [samLoadingForRun, setSamLoadingForRun] = useState(false);
  const run = useMutation({
    mutationFn: async () => {
      const body: SamAutoVisualBody = {
        sources: buildSources(),
        ref_kind: refKind,
        threshold,
        find_all: findAll,
        overwrite,
      };
      // v3.30 — pre-flight SAM load. Mirrors the text-mode Run path
      // so the visual flow never 503s on a cold backend.
      setSamLoadingForRun(true);
      try {
        await ensureSamReady();
      } finally {
        setSamLoadingForRun(false);
      }
      if (scope === "all") {
        if (!taskId) throw new Error("no_task");
        const r = await samApi.autoVisualBatch(taskId, body);
        return { kind: "batch" as const, job_id: r.job_id };
      }
      if (!assetId) throw new Error("no_asset");
      const r = await samApi.autoVisual(assetId, body);
      return { kind: "sync" as const, ...r };
    },
    onSuccess: (result) => {
      if (result.kind === "batch") {
        setRunningJobId(result.job_id);
        return;
      }
      qc.invalidateQueries({ queryKey: ["annotations"] });
      showToast(
        result.annotations_created > 0
          ? `Created ${result.annotations_created} annotation${result.annotations_created === 1 ? "" : "s"}.`
          : "No matches above the threshold.",
        {
          variant: result.annotations_created > 0 ? "success" : "warning",
        },
      );
      onSuccess?.(result.annotations_created);
      setOpen(false);
    },
    onError: (err: unknown) => {
      const friendly = inferenceErrorMessage(err);
      showToast(friendly ?? "SAM Visual Prompt failed.", { variant: "error" });
    },
  });

  if (runningJobId && taskId) {
    return (
      <VisualBatchProgressView
        taskId={taskId}
        jobId={runningJobId}
        onDone={(final) => {
          setRunningJobId(null);
          qc.invalidateQueries({ queryKey: ["annotations"] });
          onSuccess?.(final?.total_annotations_created ?? 0);
          // v3.28 — show a final toast so the user knows the run landed
          // (mirrors the auto-text BatchProgressView final-status toast).
          const created = final?.total_annotations_created ?? 0;
          const status = final?.status ?? "completed";
          if (status === "canceled") {
            showToast(
              `Visual prompt canceled. Kept ${created} annotation${created === 1 ? "" : "s"} created so far.`,
              { variant: "warning", duration: 4500 },
            );
          } else if (status === "completed_with_errors") {
            showToast(
              `Visual prompt finished with errors. Created ${created} annotation${created === 1 ? "" : "s"}; ${final?.failed ?? 0} asset${(final?.failed ?? 0) === 1 ? "" : "s"} failed.`,
              { variant: "warning", duration: 5000 },
            );
          } else if (status === "failed") {
            showToast(
              `Visual prompt batch failed${created > 0 ? ` after creating ${created} annotation${created === 1 ? "" : "s"}` : ""}.`,
              { variant: "error", duration: 5000 },
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
          setOpen(false);
        }}
        onBackground={sendToBackground}
      />
    );
  }

  return (
    <>
      {/* Ref-kind toggle (single-kind per run, gated by SAM PCS server) */}
      <div
        className="grid grid-cols-2 gap-1 p-1 rounded-[var(--radius-md)] bg-[var(--bg-subtle)] mb-3"
        data-testid="auto-visual-ref-kind"
      >
        {(["bbox", "polygon"] as const).map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => requestSwitch(k)}
            aria-pressed={refKind === k}
            data-testid={`auto-visual-ref-kind-${k}`}
            className={cn(
              "px-3 py-1.5 rounded-[var(--radius-sm)] text-[12px] font-medium transition-all duration-[160ms]",
              refKind === k
                ? "bg-[var(--bg-elev)] shadow-[0_0_0_1px_var(--accent)]"
                : "hover:bg-[var(--bg-hover)]",
            )}
          >
            {k === "bbox" ? "Bbox" : "Polygon"}
          </button>
        ))}
      </div>

      <VisualReferencePicker
        assetId={assetId}
        taskId={taskId}
        classes={classes}
        pickableAssets={refs.pickableAssets}
        annotationsByAssetId={refs.annotationsByAssetId}
        annotationsById={refs.annotationsById}
        picks={picks}
        onPicksChange={setPicks}
        refKindFilter={refKind}
        loading={refs.isLoading}
      />

      {/* Picks summary */}
      <div className="text-[11px] text-[color:var(--text-tertiary)] mt-2 mb-3">
        {summary.pickCount === 0 ? (
          <span data-testid="auto-visual-empty-hint">
            Pick at least one reference above to enable Run.
          </span>
        ) : (
          <span data-testid="auto-visual-summary">
            {summary.pickCount} pick{summary.pickCount === 1 ? "" : "s"} ·{" "}
            {summary.sourceCount} source{summary.sourceCount === 1 ? "" : "s"} ·{" "}
            {summary.classCount} class{summary.classCount === 1 ? "" : "es"}
            {summary.unassigned > 0
              ? ` · ${summary.unassigned} need${summary.unassigned === 1 ? "s" : ""} a class`
              : ""}
          </span>
        )}
      </div>

      {/* Scope */}
      <div className="grid gap-2 mb-3">
        <div className="text-[11px] uppercase tracking-[0.16em] text-[color:var(--text-tertiary)]">
          Scope
        </div>
        <div className="flex flex-col gap-1.5 text-[12.5px] text-[color:var(--text-primary)]">
          <label className="flex items-center gap-1.5 cursor-pointer">
            <input
              type="radio"
              name="auto-visual-scope"
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
            title={taskId ? "Run on all assets in this task" : "Task id missing"}
          >
            <input
              type="radio"
              name="auto-visual-scope"
              checked={scope === "all"}
              disabled={!taskId}
              onChange={() => setScope("all")}
            />
            All assets in this task
          </label>
        </div>
      </div>

      {/* Threshold */}
      <div className="grid gap-2 mb-3">
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
          data-testid="auto-visual-threshold"
        />
      </div>

      {/* Find */}
      <div className="grid gap-2 mb-3">
        <div className="text-[11px] uppercase tracking-[0.16em] text-[color:var(--text-tertiary)]">
          Find
        </div>
        <div className="flex gap-3 text-[12.5px] text-[color:var(--text-primary)]">
          <label className="flex items-center gap-1.5 cursor-pointer">
            <input
              type="radio"
              name="auto-visual-find"
              checked={findAll}
              onChange={() => setFindAll(true)}
            />
            All instances
          </label>
          <label className="flex items-center gap-1.5 cursor-pointer">
            <input
              type="radio"
              name="auto-visual-find"
              checked={!findAll}
              onChange={() => setFindAll(false)}
            />
            Best match only
          </label>
        </div>
      </div>

      <label className="flex items-center gap-2 mb-3 text-[12.5px] text-[color:var(--text-primary)] cursor-pointer">
        <Checkbox
          checked={overwrite}
          onChange={(e) => setOverwrite(e.target.checked)}
          data-testid="auto-visual-overwrite"
        />
        Replace existing annotations for assigned classes
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
          {samLoadingForRun
            ? "Loading SAM…"
            : scope === "this"
              ? "Run"
              : "Run on all assets"}
        </Button>
      </DialogFooter>

      {confirmSwitchTo && (
        <Dialog
          open={true}
          onOpenChange={(o) => {
            if (!o) setConfirmSwitchTo(null);
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Switch to {confirmSwitchTo}?</DialogTitle>
              <DialogDescription>
                Switching reference type clears your current picks (
                {summary.pickCount}).
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                variant="ghost"
                onClick={() => setConfirmSwitchTo(null)}
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                data-testid="auto-visual-switch-confirm"
                onClick={() => {
                  setPicks({});
                  setRefKind(confirmSwitchTo);
                  setConfirmSwitchTo(null);
                }}
              >
                Switch &amp; clear picks
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}

// v3.28 — Visual-prompt batch progress view. Mirrors the existing
// BatchProgressView for SAM auto-text but polls the auto-visual batch
// endpoint. Renders inside the Auto-annotate dialog while the RQ-backed
// batch is running.
function VisualBatchProgressView({
  taskId,
  jobId,
  onDone,
  onBackground,
}: {
  taskId: string;
  jobId: string;
  onDone: (
    final: {
      status: string;
      total_annotations_created: number;
      failed: number;
    } | null,
  ) => void;
  onBackground?: () => void;
}) {
  const POLL_MS = 500;
  // v3.28 — stuck-pending heuristic (mirrors YoloeBatchProgress). If the
  // worker hasn't bumped ``total`` off zero within 15s, we surface a hint
  // because that almost always means the worker is dead, the queue is
  // backed up, or the model service is unreachable.
  const [openedAt] = useState(() => Date.now());
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setTick((t) => t + 1), 1000);
    return () => window.clearInterval(id);
  }, []);
  void tick;
  const statusQ = useQuery({
    queryKey: ["sam-auto-visual-batch", taskId, jobId],
    queryFn: () => samApi.autoVisualBatchProgress(taskId, jobId),
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
      return POLL_MS;
    },
    refetchIntervalInBackground: false,
    staleTime: 0,
  });
  const data = statusQ.data;
  const status = data?.status;
  const [canceling, setCanceling] = useState(false);
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
  const pct =
    total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  const elapsedMs = Date.now() - openedAt;
  const isTerminal =
    status === "completed" ||
    status === "completed_with_errors" ||
    status === "failed" ||
    status === "canceled";
  const isStuck =
    !isTerminal && total === 0 && (status === "pending" || status === undefined) && elapsedMs > 15000;
  return (
    <div className="grid gap-3" data-testid="auto-visual-batch-progress">
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <Loader2 className="h-4 w-4 animate-spin text-[color:var(--accent)]" />
          {status === "waiting_for_gpu"
            ? "Waiting for GPU…"
            : "Running visual prompt across the task…"}
        </DialogTitle>
        <DialogDescription>
          {status === "waiting_for_gpu"
            ? "Another inference job is on the GPU; this batch will resume automatically when it's free."
            : total > 0
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
          {failed} asset{failed === 1 ? "" : "s"} failed.
        </p>
      )}
      {isStuck && (
        <div
          data-testid="auto-visual-batch-stuck-hint"
          className="flex items-start gap-1.5 text-[10.5px] text-[color:var(--warning,#d49a4a)]"
        >
          <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" aria-hidden />
          <span>
            Worker hasn't started yet. Confirm the worker container is
            up (<span className="font-mono">docker compose ps worker</span>)
            and hasn't crashed. Cancel here is safe.
          </span>
        </div>
      )}
      <p className="text-[11px] text-[color:var(--text-tertiary)] italic">
        Annotations save per-asset, so cancelling keeps everything done so far.
      </p>
      <DialogFooter className="flex-row gap-2">
        {onBackground && !isTerminal && (
          <Button
            variant="ghost"
            size="md"
            onClick={onBackground}
            data-testid="auto-visual-batch-background"
          >
            Background
          </Button>
        )}
        <Button
          variant="danger"
          size="md"
          disabled={canceling || isTerminal}
          loading={canceling}
          leftIcon={<X className="h-3.5 w-3.5" />}
          onClick={async () => {
            setCanceling(true);
            try {
              await samApi.autoVisualBatchCancel(taskId, jobId);
              showToast("Cancellation requested.", { variant: "warning" });
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
