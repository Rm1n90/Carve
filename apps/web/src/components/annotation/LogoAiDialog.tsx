// Armin Mehri — mehri.armin@gmail.com
/**
 * Logo AI — logo detection (bounding boxes only) through a hosted
 * vision LLM (Anthropic or OpenAI).
 *
 * "This image" runs synchronously. "All assets" / "Range" start a run
 * on the server, either realtime or through the provider's batch API
 * (half price, results within 24h). Runs are rows on the server: they
 * keep going when this dialog — or the browser — is closed, and their
 * results are collected there. So unlike the GPU batches, a run is
 * never handed to the floating background-jobs bar (whose leave-guard
 * cancels what it holds); this component watches the task's runs
 * itself and shows them on the "Runs" tab and as a badge on its button.
 *
 * Hidden entirely when the caller may not use it on this task or when
 * the server has no provider key configured.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BadgeCheck,
  ChevronDown,
  ChevronRight,
  Loader2,
  Plus,
  RotateCcw,
  X,
} from "lucide-react";

import {
  isLogoAiJobActive,
  logoAiApi,
  type LogoAiDelivery,
  type LogoAiDetail,
  type LogoAiJob,
  type LogoAiProviderId,
  type LogoAiReference,
  type LogoAiTaskRunRequest,
  type LogoAiTiling,
} from "@/api/logoAi";
import { assetsApi } from "@/api/assets";
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
import { useConfirm } from "@/components/ui/ConfirmDialog";
import { ScopePicker } from "@/components/annotation/ScopePicker";
import {
  VisualReferencePicker,
  type VisualPick,
} from "@/components/annotation/VisualReferencePicker";
import { LogoAiFilter } from "@/components/annotation/LogoAiFilter";
import { LogoAiPrompt } from "@/components/annotation/LogoAiPrompt";
import { LogoAiRuns, formatUsd } from "@/components/annotation/LogoAiRuns";
import { cn } from "@/lib/cn";
import {
  resolveScopeAssetIds,
  type RangeInput,
  type ScopeMode,
} from "@/lib/scopeRange";
import { showToast } from "@/lib/toast";
import { useDialogPrefs } from "@/state/dialogPrefs";
import { useTaskRefs } from "@/state/useTaskRefs";

interface LogoAiDialogProps {
  /** The asset currently open in the editor. Used for "this image". */
  assetId: string | null;
  taskId?: string;
  /** All classes in this project. */
  classes: ClassRow[];
  /** Called when new annotations exist, so the editor can refetch. */
  onSuccess?: (createdCount: number) => void;
}

interface Row {
  rid: string;
  classId: string;
  prompt: string;
}

type Tab = "new" | "runs" | "prompt";

const DETAIL_COPY: Record<LogoAiDetail, { label: string; sub: string }> = {
  low: { label: "Low", sub: "~0.6 MP · cheapest" },
  standard: { label: "Standard", sub: "~1.2 MP · recommended" },
  high: { label: "High", sub: "~2.4 MP · very small logos" },
  max: { label: "Max", sub: "Model's limit" },
};

const TILING_COPY: Record<LogoAiTiling, { label: string; sub: string }> = {
  off: { label: "Off", sub: "1 request per image" },
  auto: { label: "Tiles 2×2", sub: "Up to 5 requests" },
  fine: { label: "Tiles 3×3", sub: "Up to 10 requests" },
};

const EFFORT_LABEL: Record<string, string> = {
  none: "None (no reasoning)",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

// Training sets usually want logos that are mostly in view; a fragment
// teaches a detector little.
// "More than half of the logo in view" is what most tasks want, and 60
// is the setting that gives it. The model's estimate is good to about
// ±13 points and runs high around the middle: on 50 hand-labelled
// partial logos, a cut at 50 removed 3 of the 8 that were really under
// half, a cut at 60 removed 7 of 8, and neither lost a logo that was
// clearly more than 60% in view. No model or effort setting tested
// estimated it better, in detection or in the second pass.
const DEFAULT_MIN_VISIBLE = 60;

function newRow(classId = "", prompt = ""): Row {
  return {
    rid: `r-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    classId,
    prompt,
  };
}

/** The API's ``{error, message}`` body, or the transport error. */
function errorMessage(err: unknown): string {
  const e = err as {
    response?: { data?: { message?: string; error?: string } };
    message?: string;
  };
  return (
    e?.response?.data?.message ??
    e?.response?.data?.error ??
    e?.message ??
    "Request failed"
  );
}

function pickToBbox(p: VisualPick): [number, number, number, number] {
  if (p.geometry.kind === "bbox") return p.geometry.xyxy;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of p.geometry.points) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return [minX, minY, maxX, maxY];
}

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(value), ms);
    return () => window.clearTimeout(id);
  }, [value, ms]);
  return debounced;
}

export function LogoAiDialog({
  assetId,
  taskId,
  classes,
  onSuccess,
}: LogoAiDialogProps) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>("new");

  const [providerId, setProviderId] = useState<LogoAiProviderId | "">("");
  const [modelId, setModelId] = useState("");
  const [effort, setEffort] = useState<string | null>(null);
  const [rows, setRows] = useState<Row[]>(() => [newRow()]);
  const [picks, setPicks] = useState<Record<string, VisualPick>>({});
  const [showRefs, setShowRefs] = useState(false);
  const [detail, setDetail] = useState<LogoAiDetail>("standard");
  const [tiling, setTiling] = useState<LogoAiTiling>("off");
  const [minConfidence, setMinConfidence] = useState(0.3);
  const [minVisible, setMinVisible] = useState(DEFAULT_MIN_VISIBLE);
  const [overwrite, setOverwrite] = useState(false);
  const [skipAnnotated, setSkipAnnotated] = useState(false);
  const [delivery, setDelivery] = useState<LogoAiDelivery>("realtime");
  const [flex, setFlex] = useState(false);
  // On by default: it is what removes the boxes on stripes, laces and
  // blurs that a confidence threshold cannot.
  const [doubleCheck, setDoubleCheck] = useState(true);
  // "" = the provider's tested default.
  const [checkModelId, setCheckModelId] = useState("");
  const [checkEffort, setCheckEffort] = useState("");
  const [scope, setScope] = useState<ScopeMode>("this");
  const [scopeRange, setScopeRange] = useState<RangeInput>({ from: "", to: "" });

  // ---- server config -----------------------------------------------------
  const configQ = useQuery({
    queryKey: ["logo-ai", "config", taskId ?? ""],
    queryFn: () => logoAiApi.config(taskId),
    enabled: !!taskId,
    refetchOnWindowFocus: false,
    staleTime: 60_000,
  });
  const config = configQ.data ?? null;
  const providers = useMemo(
    () => (config?.providers ?? []).filter((p) => p.configured),
    [config],
  );
  const available = !!config?.allowed && providers.length > 0;
  const provider = providers.find((p) => p.id === providerId) ?? providers[0];
  const model =
    provider?.models.find((m) => m.id === modelId) ??
    provider?.models.find((m) => m.id === provider.default_model) ??
    provider?.models[0];
  // What is actually sent: the chosen effort if this model takes it.
  const activeEffort = !model?.efforts.length
    ? null
    : effort && model.efforts.includes(effort)
      ? effort
      : model.default_effort;
  const flexActive = !!provider?.supports_flex && flex && delivery === "realtime";
  // The second pass needs the boxes first; a batch only returns them at
  // the end, so it is a realtime (and single-image) option.
  const doubleCheckActive = doubleCheck && (scope === "this" || delivery === "realtime");
  // The check model: the chosen one, else the provider's tested default,
  // else the run's own model. Its effort likewise.
  const checkModel =
    provider?.models.find((m) => m.id === checkModelId) ??
    provider?.models.find((m) => m.id === provider.default_check_model) ??
    model;
  const defaultCheckEffort =
    checkModel && checkModel.id === provider?.default_check_model
      ? provider.default_check_effort
      : activeEffort;
  const activeCheckEffort = !checkModel?.efforts.length
    ? null
    : checkEffort && checkModel.efforts.includes(checkEffort)
      ? checkEffort
      : defaultCheckEffort && checkModel.efforts.includes(defaultCheckEffort)
        ? defaultCheckEffort
        : checkModel.default_effort;
  // Batch is only offered for models the provider's batch API takes.
  // A stored or freshly chosen combination that is not falls back to
  // Realtime, so what is sent is always what is shown.
  const batchAllowed = model?.supports_batch !== false;
  useEffect(() => {
    if (!batchAllowed && delivery === "batch") setDelivery("realtime");
  }, [batchAllowed, delivery]);

  // ---- per-task persistence ---------------------------------------------
  useEffect(() => {
    if (!open) return;
    const stored = useDialogPrefs.getState().getLogoAi(taskId);
    if (!stored) {
      // First time on this task: the server's defaults, and one row per
      // class when there are only a few, so a small project is ready to
      // run as-is.
      if (config) {
        setDetail(config.default_detail);
        setTiling(config.default_tiling);
      }
      if (classes.length > 0 && classes.length <= 8) {
        setRows(classes.map((c) => newRow(c.id, c.text_prompt ?? "")));
      }
      return;
    }
    const valid = new Set(classes.map((c) => c.id));
    const restored = stored.rows
      .filter((r) => !r.classId || valid.has(r.classId))
      .map((r) => newRow(r.classId, r.prompt));
    if (restored.length > 0) setRows(restored);
    setProviderId(stored.provider as LogoAiProviderId);
    setModelId(stored.model);
    setEffort(stored.effort);
    setDetail(stored.detail as LogoAiDetail);
    setTiling(stored.tiling as LogoAiTiling);
    setMinConfidence(stored.minConfidence);
    setMinVisible(stored.minVisible ?? DEFAULT_MIN_VISIBLE);
    setOverwrite(stored.overwrite);
    setSkipAnnotated(stored.skipAnnotated);
    setDelivery(stored.delivery);
    setFlex(stored.flex);
    setDoubleCheck(stored.doubleCheck ?? true);
    setCheckModelId(stored.checkModel ?? "");
    setCheckEffort(stored.checkEffort ?? "");
    setScope(stored.scope);
    setScopeRange({
      from: typeof stored.rangeFrom === "number" ? stored.rangeFrom : "",
      to: typeof stored.rangeTo === "number" ? stored.rangeTo : "",
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open || !provider || !model) return;
    useDialogPrefs.getState().saveLogoAi(taskId, {
      provider: provider.id,
      model: model.id,
      effort,
      rows: rows.map((r) => ({ classId: r.classId, prompt: r.prompt })),
      detail,
      tiling,
      minConfidence,
      minVisible,
      overwrite,
      skipAnnotated,
      delivery,
      flex,
      doubleCheck,
      checkModel: checkModelId,
      checkEffort,
      scope,
      ...(typeof scopeRange.from === "number" ? { rangeFrom: scopeRange.from } : {}),
      ...(typeof scopeRange.to === "number" ? { rangeTo: scopeRange.to } : {}),
    });
  }, [
    open, taskId, provider, model, effort, rows, detail, tiling, minConfidence,
    minVisible, overwrite, skipAnnotated, delivery, flex, doubleCheck, checkModelId,
    checkEffort, scope, scopeRange,
  ]);

  function clearForThisTask() {
    useDialogPrefs.getState().clearLogoAi(taskId);
    setProviderId("");
    setModelId("");
    setEffort(null);
    setRows([newRow()]);
    setPicks({});
    setDetail(config?.default_detail ?? "standard");
    setTiling(config?.default_tiling ?? "off");
    setMinConfidence(0.3);
    setMinVisible(DEFAULT_MIN_VISIBLE);
    setOverwrite(false);
    setSkipAnnotated(false);
    setDelivery("realtime");
    setFlex(false);
    setScope("this");
    setScopeRange({ from: "", to: "" });
  }

  // ---- scope -------------------------------------------------------------
  const assetsQ = useQuery({
    queryKey: ["task-assets", taskId ?? ""],
    queryFn: () => (taskId ? assetsApi.listForTask(taskId) : Promise.resolve([])),
    enabled: !!taskId && open,
    staleTime: 30_000,
  });
  const orderedAssetIds = useMemo(
    () => (assetsQ.data ?? []).map((a) => a.id),
    [assetsQ.data],
  );
  const rangeAssetIds = useMemo(
    () =>
      scope === "range"
        ? (resolveScopeAssetIds("range", scopeRange, orderedAssetIds) ?? [])
        : [],
    [scope, scopeRange, orderedAssetIds],
  );

  // ---- reference examples -----------------------------------------------
  const refs = useTaskRefs({ taskId, assetId, enabled: open && showRefs });
  const validRows = useMemo(() => rows.filter((r) => r.classId), [rows]);
  const rowClassIds = useMemo(
    () => new Set(validRows.map((r) => r.classId)),
    [validRows],
  );
  const pickList = Object.values(picks);
  const maxRefs = config?.max_references ?? 16;
  // A reference only means something for a class that is being detected.
  const strayPicks = pickList.filter((p) => !p.classId || !rowClassIds.has(p.classId));
  const references: LogoAiReference[] = pickList
    .filter((p) => p.classId && rowClassIds.has(p.classId))
    .map((p) => ({ class_id: p.classId, asset_id: p.assetId, bbox: pickToBbox(p) }));

  // ---- the request -------------------------------------------------------
  const runBody = useMemo<LogoAiTaskRunRequest | null>(() => {
    if (!provider || !model || validRows.length === 0) return null;
    // One row per class: the first description for a class wins.
    const seen = new Set<string>();
    const prompts = validRows
      .filter((r) => (seen.has(r.classId) ? false : (seen.add(r.classId), true)))
      .map((r) => ({ class_id: r.classId, prompt: r.prompt.trim() }));
    return {
      provider: provider.id,
      model: model.id,
      effort: activeEffort,
      prompts,
      references,
      detail,
      tiling,
      min_confidence: minConfidence,
      min_visible: minVisible,
      overwrite,
      flex: flexActive,
      double_check: doubleCheckActive,
      ...(doubleCheckActive && checkModel
        ? { check_model: checkModel.id, check_effort: activeCheckEffort }
        : {}),
      ...(scope === "range" ? { asset_ids: rangeAssetIds } : {}),
      ...(scope !== "this" ? { skip_annotated: skipAnnotated } : {}),
    };
    // ``references`` is rebuilt every render; ``picks`` is its source.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    provider, model, activeEffort, validRows, picks, detail, tiling,
    minConfidence, minVisible, overwrite, flexActive, doubleCheckActive, checkModel,
    activeCheckEffort, scope, rangeAssetIds, skipAnnotated,
  ]);

  const blocker: string | null = !available
    ? "Logo AI is not available"
    : validRows.length === 0
      ? "Pick at least one class to detect"
      : strayPicks.length > 0
        ? "Every reference needs a class that is being detected"
        : references.length > maxRefs
          ? `At most ${maxRefs} reference examples`
          : scope === "this" && !assetId
            ? "Open an image first"
            : scope !== "this" && !taskId
              ? "No task"
              : scope === "range" && rangeAssetIds.length === 0
                ? "The range is empty"
                : null;

  // ---- estimate (many-asset scopes only) --------------------------------
  const estimateKey = useDebounced(
    open && tab === "new" && scope !== "this" && !blocker && runBody
      ? JSON.stringify(runBody)
      : "",
    500,
  );
  const estimateQ = useQuery({
    queryKey: ["logo-ai", "estimate", taskId ?? "", estimateKey],
    queryFn: () =>
      logoAiApi.estimate(taskId!, JSON.parse(estimateKey) as LogoAiTaskRunRequest),
    enabled: !!taskId && estimateKey !== "",
    staleTime: 30_000,
    retry: false,
  });
  const estimate = estimateKey !== "" ? estimateQ.data : undefined;

  // ---- runs --------------------------------------------------------------
  const jobsQ = useQuery({
    queryKey: ["logo-ai", "jobs", taskId ?? ""],
    queryFn: () => logoAiApi.listJobs(taskId!),
    enabled: !!taskId && available,
    // Poll only while something is in flight; quickly when the user is
    // looking, lazily when the dialog is closed.
    refetchInterval: (q) =>
      (q.state.data ?? []).some(isLogoAiJobActive) ? (open ? 2500 : 15_000) : false,
    refetchIntervalInBackground: true,
    staleTime: 0,
  });
  const jobs = useMemo(() => jobsQ.data ?? [], [jobsQ.data]);
  const activeJobs = jobs.filter(isLogoAiJobActive);

  // Keep the editor in step with what runs write, and announce a run
  // finishing — whether or not the dialog is open.
  const seenRef = useRef<Map<string, { active: boolean; done: number }>>(new Map());
  useEffect(() => {
    if (!taskId) return;
    const seen = seenRef.current;
    let wrote = false;
    let finished = false;
    for (const job of jobs) {
      const prev = seen.get(job.id);
      const active = isLogoAiJobActive(job);
      seen.set(job.id, { active, done: job.done_assets });
      // First sighting: a run that ended before this page loaded is
      // history, not news.
      if (!prev) continue;
      if (job.done_assets > prev.done) wrote = true;
      if (prev.active && !active) {
        finished = true;
        const n = job.annotations_created;
        const boxes = `${n} box${n === 1 ? "" : "es"}`;
        const cost = formatUsd(job.cost_usd);
        if (job.status === "completed") {
          showToast(`Logo AI finished: ${boxes} · ${cost}.`, {
            variant: n > 0 ? "success" : "warning",
            duration: 7000,
          });
        } else if (job.status === "completed_with_errors") {
          showToast(
            `Logo AI finished with errors: ${boxes}, ${job.failed_assets} asset${job.failed_assets === 1 ? "" : "s"} failed · ${cost}.`,
            { variant: "warning", duration: 8000 },
          );
        } else if (job.status === "canceled") {
          showToast(`Logo AI canceled. Kept ${boxes} · ${cost}.`, {
            variant: "warning",
            duration: 6000,
          });
        } else {
          showToast(`Logo AI failed: ${job.error ?? "unknown error"}`, {
            variant: "error",
            duration: 9000,
          });
        }
        onSuccess?.(n);
      }
    }
    if (wrote || finished) {
      qc.invalidateQueries({ queryKey: ["annotations", taskId] });
      qc.invalidateQueries({ queryKey: ["task-annotations-raw", taskId] });
      qc.invalidateQueries({ queryKey: ["task-annotations", taskId] });
    }
    if (finished) {
      qc.invalidateQueries({ queryKey: ["task-assets", taskId] });
      qc.invalidateQueries({ queryKey: ["task-assets-count", taskId] });
    }
  }, [jobs, taskId, qc, onSuccess]);

  const modelLabelById = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of config?.providers ?? []) {
      for (const mm of p.models) m.set(mm.id, mm.label);
    }
    return m;
  }, [config]);

  async function cancelJob(job: LogoAiJob) {
    if (!taskId) return;
    // A batch that is already canceling is waiting for the provider to
    // hand over what it finished. Not waiting gives those results up.
    const force = job.status === "canceling" && job.delivery === "batch";
    if (force) {
      const ok = await confirm({
        title: "Force stop this batch?",
        description:
          "The run is waiting for the provider so it can keep the results " +
          "that are already paid for. Force stop closes it now: results " +
          "not collected yet are lost and still billed. Only do this when " +
          "the run is stuck.",
        confirmLabel: "Force stop",
        variant: "danger",
      });
      if (!ok) return;
    }
    try {
      if (force) await logoAiApi.cancelJob(taskId, job.id, true);
      else await logoAiApi.cancelJob(taskId, job.id);
      await jobsQ.refetch();
    } catch (err) {
      showToast(`Cancel failed: ${errorMessage(err)}`, { variant: "error" });
    }
  }

  // ---- run ---------------------------------------------------------------
  const run = useMutation({
    mutationFn: async () => {
      if (!runBody) throw new Error("nothing to run");
      if (scope === "this") {
        if (!assetId) throw new Error("no asset");
        return { kind: "sync" as const, res: await logoAiApi.detect(assetId, runBody) };
      }
      if (!taskId) throw new Error("no task");
      return {
        kind: "job" as const,
        job: await logoAiApi.createJob(taskId, { ...runBody, delivery }),
      };
    },
    onSuccess: (data) => {
      if (data.kind === "job") {
        qc.invalidateQueries({ queryKey: ["logo-ai", "jobs", taskId ?? ""] });
        setTab("runs");
        showToast(
          data.job.delivery === "batch"
            ? "Batch submitted. Results arrive within 24 hours and are collected automatically."
            : "Logo AI run started.",
          { variant: "info", duration: 5000 },
        );
        return;
      }
      const { res } = data;
      const n = res.annotations_created;
      const tail =
        ((res.served_at_full_price ?? 0) > 0
          ? ` · ${res.served_at_full_price} request(s) were served at the standard price, not Flex`
          : "") +
        ((res.rejected ?? 0) > 0 ? ` · ${res.rejected} rejected on the second look` : "") +
        (res.mostly_hidden > 0 ? ` · ${res.mostly_hidden} mostly hidden left out` : "") +
        (res.below_threshold > 0 ? ` · ${res.below_threshold} under the confidence threshold` : "") +
        (res.overwrite_skipped ? " · existing annotations kept" : "");
      showToast(
        `Logo AI created ${n} box${n === 1 ? "" : "es"}${tail} · ${formatUsd(res.cost_usd)}.`,
        { variant: n > 0 ? "success" : "warning", duration: 6000 },
      );
      onSuccess?.(n);
      qc.invalidateQueries({ queryKey: ["annotations"] });
      // The run is now in the task's history, which the Runs tab lists
      // and the next cost estimate is averaged over.
      qc.invalidateQueries({ queryKey: ["logo-ai", "jobs", taskId ?? ""] });
      qc.invalidateQueries({ queryKey: ["logo-ai", "estimate", taskId ?? ""] });
      if (taskId) {
        qc.invalidateQueries({ queryKey: ["task-annotations", taskId] });
        qc.invalidateQueries({ queryKey: ["task-assets", taskId] });
      }
      setOpen(false);
    },
    onError: (err) => {
      showToast(`Logo AI: ${errorMessage(err)}`, { variant: "error", duration: 8000 });
    },
  });

  // Hidden until the server says it is usable here (see file header).
  if (!available) return null;

  const usedClassIds = new Set(rows.map((r) => r.classId).filter(Boolean));
  const unusedClasses = classes.filter((c) => !usedClassIds.has(c.id));
  const patchRow = (rid: string, patch: Partial<Row>) =>
    setRows((prev) => prev.map((r) => (r.rid === rid ? { ...r, ...patch } : r)));

  const trigger = (
    <button
      type="button"
      data-testid="logo-ai-open"
      title={
        activeJobs.length > 0
          ? `Logo AI — ${activeJobs.length} run${activeJobs.length === 1 ? "" : "s"} in progress`
          : "Detect logos with a vision LLM"
      }
      aria-label="Logo AI"
      className={cn(
        // Same pill shape as My Model / Auto-Annotate / Smart Find;
        // teal marks it as the hosted-model tool.
        "relative inline-flex h-8 shrink-0 items-center gap-1.5 px-3 rounded-[var(--radius-pill)] whitespace-nowrap",
        "bg-[#0d9488] text-white text-[12.5px] font-medium tracking-[0.2px]",
        "border border-[#0d9488]",
        "transition-all duration-[180ms] ease-out",
        "hover:bg-[#0f766e] hover:border-white",
        "hover:shadow-[0_0_0_2px_#0d9488] hover:scale-[1.05]",
        "active:opacity-60 active:scale-100",
      )}
    >
      {activeJobs.length > 0 ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
      ) : (
        <BadgeCheck className="h-3.5 w-3.5" aria-hidden />
      )}
      <span className="hidden min-[1440px]:inline">Logo AI</span>
      {activeJobs.length > 0 && (
        <span
          data-testid="logo-ai-active-badge"
          className="grid h-4 min-w-4 place-items-center rounded-full bg-white px-1 text-[10px] font-semibold text-[#0d9488]"
        >
          {activeJobs.length}
        </span>
      )}
    </button>
  );

  return (
    <>
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        // Reopen on whatever needs attention.
        if (o) setTab(activeJobs.length > 0 ? "runs" : "new");
      }}
    >
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="w-[min(94vw,720px)] grid gap-3">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <BadgeCheck className="h-4 w-4 text-[#0d9488]" aria-hidden />
            Logo AI
            <span className="text-[11px] font-normal text-[color:var(--text-tertiary)]">
              Vision-LLM logo detection · boxes only
            </span>
          </DialogTitle>
          <DialogDescription>
            Finds logos with a hosted vision model and saves them as
            bounding boxes. Images are sent to the selected provider.
          </DialogDescription>
        </DialogHeader>

        {/* global.css makes buttons, inputs and selects inherit their
            font, so a text size on the control itself is ignored. Sizes
            are set on the containers here and inherited. */}
        <div
          data-testid="logo-ai-dialog"
          className="grid grid-cols-3 gap-1 p-1 rounded-[var(--radius-md)] bg-[var(--bg-subtle)] text-[12px] font-medium"
        >
          {(
            [
              { id: "new" as const, label: "New run" },
              {
                id: "runs" as const,
                label: `Runs${activeJobs.length > 0 ? ` · ${activeJobs.length} active` : ""}`,
              },
              { id: "prompt" as const, label: "Prompt" },
            ]
          ).map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              data-testid={`logo-ai-tab-${t.id}`}
              className={cn(
                "h-8 rounded-[var(--radius-sm)] transition-all duration-[160ms]",
                tab === t.id
                  ? "bg-[var(--bg-elev)] shadow-[0_0_0_1px_var(--accent)]"
                  : "text-[color:var(--text-secondary)] hover:bg-[var(--bg-hover)]",
              )}
            >
              {t.label}
            </button>
          ))}
        </div>

        {tab === "prompt" && taskId ? (
          <LogoAiPrompt
            taskId={taskId}
            providerId={provider?.id}
            modelId={model?.id}
            onClose={() => setOpen(false)}
          />
        ) : tab === "runs" ? (
          <>
            <div className="text-[12px]">
            <LogoAiRuns
              jobs={jobs}
              loading={jobsQ.isLoading}
              modelLabel={(j) => modelLabelById.get(j.model) ?? j.model}
              onCancel={cancelJob}
            />
            </div>
            <DialogFooter>
              <Button variant="ghost" size="md" onClick={() => setOpen(false)}>
                Close
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <div className="grid gap-4 max-h-[calc(88vh-300px)] min-h-[180px] overflow-y-auto pr-2 text-[12px]">
              {/* Model */}
              <section className="grid gap-2">
                <div className="grid grid-cols-[1fr_1.6fr_1fr] gap-2">
                  <label className="grid gap-1 text-[11px] text-[color:var(--text-secondary)]">
                    Provider
                    <select
                      value={provider?.id ?? ""}
                      onChange={(e) => {
                        setProviderId(e.target.value as LogoAiProviderId);
                        setModelId("");
                      }}
                      data-testid="logo-ai-provider"
                      className="h-9 px-2 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-elev)] text-[color:var(--text-primary)]"
                    >
                      {providers.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="grid gap-1 text-[11px] text-[color:var(--text-secondary)]">
                    Model
                    <select
                      value={model?.id ?? ""}
                      onChange={(e) => setModelId(e.target.value)}
                      data-testid="logo-ai-model"
                      className="h-9 px-2 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-elev)] text-[color:var(--text-primary)]"
                    >
                      {(provider?.models ?? []).map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.label} — ${m.input_usd}/${m.output_usd} per MTok
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="grid gap-1 text-[11px] text-[color:var(--text-secondary)]">
                    Effort
                    <select
                      value={activeEffort ?? ""}
                      onChange={(e) => setEffort(e.target.value)}
                      disabled={!model?.efforts.length}
                      data-testid="logo-ai-effort"
                      title={
                        model?.efforts.length
                          ? "How much the model reasons before answering. Reasoning is billed as output and is the largest part of the cost."
                          : "This model has no effort control"
                      }
                      className="h-9 px-2 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-elev)] text-[color:var(--text-primary)] disabled:opacity-50"
                    >
                      {model?.efforts.length ? (
                        model.efforts.map((e) => (
                          <option key={e} value={e}>
                            {EFFORT_LABEL[e] ?? e}
                          </option>
                        ))
                      ) : (
                        <option value="">Not supported</option>
                      )}
                    </select>
                  </label>
                </div>
                {model && (
                  <p className="text-[10.5px] text-[color:var(--text-tertiary)]">
                    {model.blurb}
                  </p>
                )}
              </section>

              {/* What to find */}
              <section className="grid gap-2">
                <div className="flex items-center justify-between">
                  <span className="text-[12px] font-medium">Logos to find</span>
                  <span className="text-[10.5px] text-[color:var(--text-tertiary)] font-mono tabular-nums">
                    {validRows.length} class{validRows.length === 1 ? "" : "es"}
                  </span>
                </div>
                <div className="grid gap-1.5 max-h-[220px] overflow-y-auto pr-1">
                  {rows.map((row) => {
                    const cls = classes.find((c) => c.id === row.classId);
                    return (
                      <div
                        key={row.rid}
                        className="grid grid-cols-[180px_1fr_28px] gap-1.5 items-center p-1.5 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-elev)]"
                      >
                        <div className="flex items-center gap-1.5 min-w-0">
                          <span
                            className="h-2.5 w-2.5 rounded-sm shrink-0 ring-1 ring-black/10"
                            style={{ backgroundColor: cls?.color ?? "var(--bg-subtle)" }}
                            aria-hidden
                          />
                          <select
                            value={row.classId}
                            onChange={(e) => patchRow(row.rid, { classId: e.target.value })}
                            data-testid={`logo-ai-class-${row.rid}`}
                            className="flex-1 min-w-0 h-8 px-2 rounded-[var(--radius-sm)] bg-transparent outline-none focus:bg-[var(--bg-hover)]"
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
                          onChange={(e) => patchRow(row.rid, { prompt: e.target.value })}
                          maxLength={400}
                          placeholder={
                            cls
                              ? `Optional: what the ${cls.name} logo looks like`
                              : "Optional description"
                          }
                          data-testid={`logo-ai-prompt-${row.rid}`}
                          className="h-8 px-2.5 rounded-[var(--radius-sm)] bg-transparent outline-none focus:bg-[var(--bg-hover)] min-w-0"
                        />
                        <button
                          type="button"
                          onClick={() =>
                            setRows((prev) =>
                              prev.length === 1 ? [newRow()] : prev.filter((r) => r.rid !== row.rid),
                            )
                          }
                          aria-label="Remove row"
                          className="h-7 w-7 grid place-items-center rounded-[var(--radius-sm)] text-[color:var(--text-tertiary)] hover:text-[color:var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors duration-[140ms]"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    );
                  })}
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setRows((prev) => [...prev, newRow()])}
                    data-testid="logo-ai-add-row"
                    className="inline-flex items-center gap-1 h-7 px-2 rounded-[var(--radius-sm)] text-[color:var(--accent)] border border-dashed border-[color:var(--accent)]/40 transition-all duration-[160ms] hover:bg-[var(--accent)]/10 hover:border-[color:var(--accent)]"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    Add class
                  </button>
                  {unusedClasses.length > 1 && unusedClasses.length <= 100 && (
                    <button
                      type="button"
                      onClick={() =>
                        setRows((prev) => [
                          ...prev.filter((r) => r.classId),
                          ...unusedClasses.map((c) => newRow(c.id, c.text_prompt ?? "")),
                        ])
                      }
                      data-testid="logo-ai-add-all"
                      className="h-7 px-2 rounded-[var(--radius-sm)] text-[color:var(--text-secondary)] hover:bg-[var(--bg-hover)]"
                    >
                      Add all {unusedClasses.length} remaining
                    </button>
                  )}
                </div>
                <p className="text-[10.5px] text-[color:var(--text-tertiary)]">
                  The class name is what the model searches for, so name
                  classes after the brand. Use a single class described as
                  “any brand logo” to box every logo regardless of brand.
                </p>
              </section>

              {/* Reference examples */}
              <section className="grid gap-2">
                <button
                  type="button"
                  onClick={() => setShowRefs((v) => !v)}
                  data-testid="logo-ai-refs-toggle"
                  className="flex items-center gap-1.5 text-left"
                >
                  {showRefs ? (
                    <ChevronDown className="h-3.5 w-3.5" aria-hidden />
                  ) : (
                    <ChevronRight className="h-3.5 w-3.5" aria-hidden />
                  )}
                  <span className="font-medium">Reference examples</span>
                  <span className="text-[color:var(--text-tertiary)]">
                    {pickList.length > 0
                      ? `${pickList.length}/${maxRefs} picked`
                      : "optional — show the model what each logo looks like"}
                  </span>
                </button>
                {showRefs && (
                  <>
                    <VisualReferencePicker
                      assetId={assetId}
                      taskId={taskId}
                      classes={classes}
                      pickableAssets={refs.pickableAssets}
                      annotationsByAssetId={refs.annotationsByAssetId}
                      annotationsById={refs.annotationsById}
                      picks={picks}
                      onPicksChange={setPicks}
                      loading={refs.isLoading}
                    />
                    <p className="text-[10.5px] text-[color:var(--text-tertiary)]">
                      Pick a few existing boxes per class. Their crops are
                      sent with every request as examples — the biggest
                      accuracy gain for brands the model does not know —
                      and sit in the cached part of the prompt, so they add
                      little to the cost.
                    </p>
                  </>
                )}
              </section>

              {/* Quality and cost */}
              <section className="grid gap-2">
                <div className="grid grid-cols-2 gap-3">
                  <div className="grid gap-1">
                    <span className="text-[11px] text-[color:var(--text-secondary)]">
                      Image detail
                    </span>
                    <div className="grid grid-cols-4 gap-1 p-1 rounded-[var(--radius-md)] bg-[var(--bg-subtle)]">
                      {(config?.details ?? []).map((d) => (
                        <button
                          key={d}
                          type="button"
                          onClick={() => setDetail(d)}
                          title={DETAIL_COPY[d].sub}
                          data-testid={`logo-ai-detail-${d}`}
                          className={cn(
                            "h-7 rounded-[var(--radius-sm)] transition-all duration-[140ms]",
                            detail === d
                              ? "bg-[var(--bg-elev)] shadow-[0_0_0_1px_var(--accent)]"
                              : "hover:bg-[var(--bg-hover)]",
                          )}
                        >
                          {DETAIL_COPY[d].label}
                        </button>
                      ))}
                    </div>
                    <span className="text-[10.5px] text-[color:var(--text-tertiary)]">
                      {DETAIL_COPY[detail].sub}. Larger images are shrunk to
                      this before upload, for realtime and batch alike;
                      smaller ones are sent as they are.
                    </span>
                  </div>
                  <div className="grid gap-1">
                    <span className="text-[11px] text-[color:var(--text-secondary)]">
                      Small-logo scan
                    </span>
                    <div className="grid grid-cols-3 gap-1 p-1 rounded-[var(--radius-md)] bg-[var(--bg-subtle)]">
                      {(config?.tilings ?? []).map((t) => (
                        <button
                          key={t}
                          type="button"
                          onClick={() => setTiling(t)}
                          title={TILING_COPY[t].sub}
                          data-testid={`logo-ai-tiling-${t}`}
                          className={cn(
                            "h-7 rounded-[var(--radius-sm)] transition-all duration-[140ms]",
                            tiling === t
                              ? "bg-[var(--bg-elev)] shadow-[0_0_0_1px_var(--accent)]"
                              : "hover:bg-[var(--bg-hover)]",
                          )}
                        >
                          {TILING_COPY[t].label}
                        </button>
                      ))}
                    </div>
                    <span className="text-[10.5px] text-[color:var(--text-tertiary)]">
                      {tiling === "off"
                        ? "The whole image in one request."
                        : `${TILING_COPY[tiling].sub} for large images: the full frame plus overlapping crops, merged.`}
                    </span>
                  </div>
                </div>

                <label className="grid gap-0.5 text-[11px] text-[color:var(--text-secondary)]">
                  <span className="flex items-center justify-between">
                    Keep boxes with confidence at or above
                    <span className="font-mono text-[10.5px] text-[color:var(--text-tertiary)]">
                      {minConfidence.toFixed(2)}
                    </span>
                  </span>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={minConfidence}
                    onChange={(e) => setMinConfidence(Number(e.target.value))}
                    className="w-full"
                    data-testid="logo-ai-min-confidence"
                  />
                </label>

                <label className="grid gap-0.5 text-[11px] text-[color:var(--text-secondary)]">
                  <span className="flex items-center justify-between">
                    {minVisible === 0
                      ? "Keep logos however little of them is visible"
                      : "Leave out logos with less of them visible than"}
                    <span className="font-mono text-[10.5px] text-[color:var(--text-tertiary)]">
                      {minVisible}%
                    </span>
                  </span>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    step={5}
                    value={minVisible}
                    onChange={(e) => setMinVisible(Number(e.target.value))}
                    className="w-full"
                    data-testid="logo-ai-min-visible"
                  />
                  <span className="text-[10.5px] text-[color:var(--text-tertiary)]">
                    For "more than half in view", use 60: the estimate runs about ten points
                    high around the middle. The model estimates how much of each logo is in view
                    (cut by the frame, covered, or wrapped out of sight);
                    boxes under this are dropped. Each box keeps its
                    scores, so you can run with loose values and tighten
                    them afterwards with the filter button next to Logo
                    AI, at no extra cost.
                  </span>
                </label>
              </section>

              {/* Scope + delivery */}
              <section className="grid gap-2">
                <ScopePicker
                  name="logo-ai-scope"
                  mode={scope}
                  onModeChange={setScope}
                  range={scopeRange}
                  onRangeChange={setScopeRange}
                  totalAssets={orderedAssetIds.length}
                  hasTask={!!taskId}
                  hasAsset={!!assetId}
                />

                {scope !== "this" && (
                  <div className="grid gap-1">
                    <span className="text-[11px] text-[color:var(--text-secondary)]">
                      Delivery
                    </span>
                    <div className="grid grid-cols-2 gap-1 p-1 rounded-[var(--radius-md)] bg-[var(--bg-subtle)]">
                      {(
                        [
                          {
                            v: "realtime" as const,
                            label: "Realtime",
                            sub: "Starts now, full price",
                          },
                          {
                            v: "batch" as const,
                            label: "Batch · 50% off",
                            sub: batchAllowed
                              ? "Usually under an hour, at most 24h"
                              : `Not offered for ${model?.label ?? "this model"} by the provider's batch API`,
                          },
                        ]
                      ).map((opt) => (
                        <button
                          key={opt.v}
                          type="button"
                          disabled={opt.v === "batch" && !batchAllowed}
                          onClick={() => setDelivery(opt.v)}
                          data-testid={`logo-ai-delivery-${opt.v}`}
                          className={cn(
                            "flex flex-col items-start px-3 py-1.5 rounded-[var(--radius-sm)] text-left transition-all duration-[140ms]",
                            delivery === opt.v
                              ? "bg-[var(--bg-elev)] shadow-[0_0_0_1px_var(--accent)]"
                              : "hover:bg-[var(--bg-hover)]",
                            opt.v === "batch" && !batchAllowed && "opacity-50 cursor-not-allowed",
                          )}
                        >
                          <span className="text-[12px] font-medium">{opt.label}</span>
                          <span className="text-[10px] text-[color:var(--text-tertiary)]">
                            {opt.sub}
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {(scope === "this" || delivery === "realtime") && (
                  <label className="flex items-start gap-2 text-[12.5px] cursor-pointer">
                    <Checkbox
                      checked={doubleCheck}
                      onChange={(e) => setDoubleCheck(e.target.checked)}
                      data-testid="logo-ai-double-check"
                    />
                    <span>
                      Double-check every box: a second request shows a model each box
                      enlarged and scores it. Boxes that are not logos (stripes, laces, blurs,
                      whole wheels) are dropped, and the score becomes the box's confidence.
                    </span>
                  </label>
                )}
                {doubleCheckActive && (
                  <div className="grid grid-cols-[1fr_140px] gap-2 pl-6">
                    <label className="grid gap-1 text-[11px] text-[color:var(--text-secondary)]">
                      Check model
                      <select
                        value={checkModel?.id ?? ""}
                        onChange={(e) => {
                          setCheckModelId(e.target.value);
                          setCheckEffort("");
                        }}
                        data-testid="logo-ai-check-model"
                        className="h-9 px-2 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-elev)] text-[color:var(--text-primary)]"
                      >
                        {(provider?.models ?? []).map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.label} — ${m.input_usd}/${m.output_usd} per MTok
                            {m.id === provider?.default_check_model ? " · recommended" : ""}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="grid gap-1 text-[11px] text-[color:var(--text-secondary)]">
                      Check effort
                      <select
                        value={activeCheckEffort ?? ""}
                        onChange={(e) => setCheckEffort(e.target.value)}
                        disabled={!checkModel?.efforts.length}
                        data-testid="logo-ai-check-effort"
                        className="h-9 px-2 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-elev)] text-[color:var(--text-primary)] disabled:opacity-50"
                      >
                        {checkModel?.efforts.length ? (
                          checkModel.efforts.map((e) => (
                            <option key={e} value={e}>
                              {EFFORT_LABEL[e] ?? e}
                            </option>
                          ))
                        ) : (
                          <option value="">Not supported</option>
                        )}
                      </select>
                    </label>
                    <span className="col-span-2 text-[10.5px] text-[color:var(--text-tertiary)]">
                      {provider?.default_check_model
                        ? "The recommended model and low effort removed about half of the wrong boxes in testing and lost about 2% of real logos. Cheaper models lost more real logos; more effort did not help."
                        : "No model has been tested for this provider's check; it uses the run's own model unless you pick another."}
                    </span>
                  </div>
                )}

                {provider?.supports_flex && (scope === "this" || delivery === "realtime") && (
                  <label className="flex items-center gap-2 text-[12.5px] cursor-pointer">
                    <Checkbox
                      checked={flex}
                      onChange={(e) => setFlex(e.target.checked)}
                      data-testid="logo-ai-flex"
                    />
                    Flex pricing: 50% off, slower responses, for detection and the
                    double-check alike. Never sent at the standard price: with no Flex
                    capacity the run waits and retries, and if OpenAI ever serves a request
                    at standard anyway the run stops at once.
                  </label>
                )}
                {scope !== "this" && (
                  <label className="flex items-center gap-2 text-[12.5px] cursor-pointer">
                    <Checkbox
                      checked={skipAnnotated}
                      onChange={(e) => setSkipAnnotated(e.target.checked)}
                      data-testid="logo-ai-skip-annotated"
                    />
                    Skip images that already have annotations
                  </label>
                )}
                <label className="flex items-center gap-2 text-[12.5px] cursor-pointer">
                  <Checkbox
                    checked={overwrite}
                    onChange={(e) => setOverwrite(e.target.checked)}
                    data-testid="logo-ai-overwrite"
                  />
                  Replace existing annotations where logos are found
                </label>

                {scope !== "this" && (
                  <div
                    data-testid="logo-ai-estimate"
                    className="p-2.5 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-elev)] text-[11.5px]"
                  >
                    {blocker ? (
                      <span className="text-[color:var(--text-tertiary)]">
                        Cost estimate appears once the run is ready.
                      </span>
                    ) : estimate ? (
                      <div className="grid gap-0.5">
                        <div className="font-medium">
                          About{" "}
                          {formatUsd(
                            delivery === "batch"
                              ? estimate.cost_batch_usd
                              : flexActive && estimate.cost_flex_usd != null
                                ? estimate.cost_flex_usd
                                : estimate.cost_realtime_usd,
                          )}{" "}
                          for {estimate.assets} image{estimate.assets === 1 ? "" : "s"}
                          {estimate.requests !== estimate.assets
                            ? ` (${estimate.requests} requests)`
                            : ""}
                        </div>
                        <div className="text-[color:var(--text-secondary)]">
                          Realtime {formatUsd(estimate.cost_realtime_usd)} · Batch{" "}
                          {formatUsd(estimate.cost_batch_usd)}
                          {estimate.cost_flex_usd != null
                            ? ` · Flex ${formatUsd(estimate.cost_flex_usd)}`
                            : ""}
                        </div>
                        <div className="text-[10.5px] text-[color:var(--text-tertiary)]">
                          {estimate.based_on_requests > 0
                            ? `Based on what ${estimate.based_on_requests} earlier request${estimate.based_on_requests === 1 ? "" : "s"} with this model and effort cost in this task.`
                            : "A rough guide until this task has a run with this model and effort: cost depends on how many logos the images hold. Run one image first to calibrate it."}
                          {" "}The run shows its actual cost as it goes.
                          {estimate.prefix_cached
                            ? " The shared prompt is cached and re-read at the cache rate."
                            : ` The shared prompt is under this model's ${estimate.min_cache_tokens}-token caching minimum, so it is billed in full each time.`}
                        </div>
                      </div>
                    ) : estimateQ.isError ? (
                      <span className="text-[color:var(--danger)]">
                        Could not estimate: {errorMessage(estimateQ.error)}
                      </span>
                    ) : (
                      <span className="flex items-center gap-1.5 text-[color:var(--text-secondary)]">
                        <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
                        Estimating cost…
                      </span>
                    )}
                  </div>
                )}
              </section>
            </div>

            <DialogFooter>
              <Button
                variant="ghost"
                size="md"
                onClick={clearForThisTask}
                data-testid="logo-ai-clear"
                title="Reset this dialog for the task (also wipes the saved setup)"
                className="mr-auto"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                Clear
              </Button>
              <Button variant="ghost" size="md" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button
                variant="primary"
                size="md"
                disabled={!!blocker || (activeJobs.length > 0 && scope !== "this")}
                loading={run.isPending}
                onClick={() => run.mutate()}
                data-testid="logo-ai-run"
                title={
                  blocker ??
                  (activeJobs.length > 0 && scope !== "this"
                    ? "A run is already in progress for this task"
                    : undefined)
                }
              >
                {scope === "this"
                  ? "Run"
                  : delivery === "batch"
                    ? "Submit batch"
                    : scope === "range"
                      ? `Run on ${rangeAssetIds.length} asset${rangeAssetIds.length === 1 ? "" : "s"}`
                      : "Run on all assets"}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
    {/* Boxes keep their scores, so thresholds can be tightened after a
        run without paying for it again. */}
    <LogoAiFilter taskId={taskId} assetId={assetId} onApplied={() => onSuccess?.(0)} />
    </>
  );
}
