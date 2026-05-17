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
  RotateCcw,
  ScanEye,
  Sparkles,
  Type,
  X,
} from "lucide-react";

import { yoloeApi } from "@/api/yoloe";
import type { YoloeOutputKind, YoloeVisualSource } from "@/api/yoloe";
import type { ClassRow } from "@/api/classes";
import { annotationsApi } from "@/api/annotations";
import { assetsApi } from "@/api/assets";
import type { Asset } from "@/api/assets";
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
import { inferenceErrorMessage } from "@/lib/inferenceErrors";
import { useBackgroundJobs } from "@/state/backgroundJobs";
import { useDialogPrefs } from "@/state/dialogPrefs";
import { useAnnotations } from "@/state/annotations";
import {
  VisualReferencePicker,
  type VisualPick,
} from "@/components/annotation/VisualReferencePicker";
import { ScopePicker } from "@/components/annotation/ScopePicker";
import { HierarchyResolverPanel } from "@/components/annotation/HierarchyResolverPanel";
import {
  resolveScopeAssetIds,
  type RangeInput,
  type ScopeMode,
} from "@/lib/scopeRange";

type YoloeMode = "text" | "visual" | "prompt_free";
// v3.31 — widened from "this" | "all" to also include the
// 1-based asset-position "range" scope.
type Scope = ScopeMode;

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
  // v3.24.3 — config (conf, iou, output_kind, overwrite, scope) is
  // PER-MODE. Sliders / pills the user moves in Text mode no longer
  // propagate to Visual or Prompt-Free, and vice versa. State carries
  // one ``ModeConfig`` per mode plus a derived alias for the active
  // mode so the JSX stays compact.
  interface ModeConfig {
    conf: number;
    iou: number;
    outputKind: YoloeOutputKind;
    overwrite: boolean;
    scope: Scope;
  }
  const DEFAULT_MODE_CONFIG: ModeConfig = {
    conf: 0.25,
    iou: 0.7,
    outputKind: "bbox",
    overwrite: false,
    scope: "this",
  };
  const [configByMode, setConfigByMode] = useState<Record<YoloeMode, ModeConfig>>(
    () => ({
      text: { ...DEFAULT_MODE_CONFIG },
      visual: { ...DEFAULT_MODE_CONFIG },
      prompt_free: { ...DEFAULT_MODE_CONFIG },
    }),
  );
  const activeConfig = configByMode[mode];
  const { conf, iou, outputKind, overwrite, scope } = activeConfig;
  function patchActiveConfig(patch: Partial<ModeConfig>) {
    setConfigByMode((prev) => ({
      ...prev,
      [mode]: { ...prev[mode], ...patch },
    }));
  }

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

  // Visual mode state (v3.24 multi-source) — picks are keyed by
  // ``${assetId}:${annotationId}`` so refs from different source
  // assets coexist. The shared VisualReferencePicker owns toggle /
  // class-assign logic; YoloeDialog only owns the picks map and
  // converts it to the YOLOE wire payload.
  const [picks, setPicks] = useState<Record<string, VisualPick>>(() => ({}));

  // Prompt-free mode state
  const [pfClassId, setPfClassId] = useState<string>("");
  const [pfMaxDet, setPfMaxDet] = useState<number>(300);

  // v3.31 — 1-based asset position range, shared across all three modes
  // (the user typically picks ONE range for "this Smart Find run" and
  // expects mode-flipping to keep it). Persisted into every mode-config
  // slot in localStorage so older dialogs can still read it.
  const [scopeRange, setScopeRange] = useState<RangeInput>({
    from: "",
    to: "",
  });
  // v3.31 — cross-class hierarchy NMS. Shared across modes too; same
  // rationale as scopeRange. Default ON when the project has hierarchies.
  const projectHasHierarchy = useMemo(
    () => classes.some((c) => !!c.parent_class_id),
    [classes],
  );
  const [resolveHierarchy, setResolveHierarchy] = useState<boolean>(
    projectHasHierarchy,
  );
  const [hierarchyIou, setHierarchyIou] = useState<number>(0.7);

  // (Common controls — conf/iou/overwrite/outputKind — moved into
  // ``configByMode`` above so each prompt mode keeps its own values.)

  // Active batch tracking
  const [runningJobId, setRunningJobId] = useState<string | null>(null);

  // v3.30 — per-task persistence. Hydrate when the dialog opens and
  // write back whenever the user edits the form. Visual-mode picks
  // are intentionally NOT persisted because they reference concrete
  // annotation ids that may have been deleted between sessions; all
  // other settings (rows, sliders, scope, overwrite, output kind,
  // prompt-free class + max-det) are.
  useEffect(() => {
    if (!open) return;
    const stored = useDialogPrefs.getState().getSmartFind(taskId);
    if (!stored) return;
    if (stored.mode) setMode(stored.mode);
    // v3.31 — pick range fields off whichever stored mode-config has
    // them. We persist the same value into all three slots; reading
    // any one is sufficient and stays tolerant to older pref entries
    // that only have it on a subset of modes.
    const rangeFrom =
      stored.text?.rangeFrom ??
      stored.prompt_free?.rangeFrom ??
      stored.visual_common?.rangeFrom;
    const rangeTo =
      stored.text?.rangeTo ??
      stored.prompt_free?.rangeTo ??
      stored.visual_common?.rangeTo;
    setScopeRange({
      from:
        typeof rangeFrom === "number" && Number.isFinite(rangeFrom)
          ? rangeFrom
          : "",
      to:
        typeof rangeTo === "number" && Number.isFinite(rangeTo)
          ? rangeTo
          : "",
    });
    // v3.31 — hydrate hierarchy toggle from any mode-config slot.
    const storedResolve =
      stored.text?.resolveHierarchy ??
      stored.prompt_free?.resolveHierarchy ??
      stored.visual_common?.resolveHierarchy;
    const storedIou =
      stored.text?.hierarchyIou ??
      stored.prompt_free?.hierarchyIou ??
      stored.visual_common?.hierarchyIou;
    setResolveHierarchy(
      typeof storedResolve === "boolean"
        ? storedResolve
        : projectHasHierarchy,
    );
    setHierarchyIou(
      typeof storedIou === "number" && Number.isFinite(storedIou)
        ? Math.max(0, Math.min(1, storedIou))
        : 0.7,
    );
    if (stored.text) {
      const validClassIds = new Set(classes.map((c) => c.id));
      const rows = stored.text.rows
        .filter((r) => !r.classId || validClassIds.has(r.classId))
        .map((r, i) => ({
          rid: `pref-${i}-${r.classId || "empty"}`,
          classId: r.classId,
          prompt: r.prompt,
        }));
      if (rows.length > 0) setTextRows(rows);
      setConfigByMode((prev) => ({
        ...prev,
        text: {
          ...prev.text,
          conf: stored.text!.conf,
          iou: stored.text!.iou,
          outputKind: stored.text!.outputKind as YoloeOutputKind,
          overwrite: stored.text!.overwrite,
          scope: stored.text!.scope,
        },
      }));
    }
    if (stored.prompt_free) {
      setPfClassId(stored.prompt_free.classId);
      setPfMaxDet(stored.prompt_free.maxDet);
      setConfigByMode((prev) => ({
        ...prev,
        prompt_free: {
          ...prev.prompt_free,
          conf: stored.prompt_free!.conf,
          iou: stored.prompt_free!.iou,
          outputKind: stored.prompt_free!.outputKind as YoloeOutputKind,
          overwrite: stored.prompt_free!.overwrite,
          scope: stored.prompt_free!.scope,
        },
      }));
    }
    if (stored.visual_common) {
      setConfigByMode((prev) => ({
        ...prev,
        visual: {
          ...prev.visual,
          conf: stored.visual_common!.conf,
          iou: stored.visual_common!.iou,
          outputKind: stored.visual_common!.outputKind as YoloeOutputKind,
          overwrite: stored.visual_common!.overwrite,
          scope: stored.visual_common!.scope,
        },
      }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Write back on every relevant change while the dialog is open.
  useEffect(() => {
    if (!open) return;
    const rangeFields = {
      ...(typeof scopeRange.from === "number"
        ? { rangeFrom: scopeRange.from }
        : {}),
      ...(typeof scopeRange.to === "number"
        ? { rangeTo: scopeRange.to }
        : {}),
      // v3.31 — persist hierarchy toggle into every mode-config slot.
      resolveHierarchy,
      hierarchyIou,
    };
    useDialogPrefs.getState().saveSmartFind(taskId, {
      mode,
      text: {
        rows: textRows.map((r) => ({ classId: r.classId, prompt: r.prompt })),
        conf: configByMode.text.conf,
        iou: configByMode.text.iou,
        outputKind: configByMode.text.outputKind,
        overwrite: configByMode.text.overwrite,
        scope: configByMode.text.scope,
        ...rangeFields,
      },
      prompt_free: {
        classId: pfClassId,
        maxDet: pfMaxDet,
        conf: configByMode.prompt_free.conf,
        iou: configByMode.prompt_free.iou,
        outputKind: configByMode.prompt_free.outputKind,
        overwrite: configByMode.prompt_free.overwrite,
        scope: configByMode.prompt_free.scope,
        ...rangeFields,
      },
      visual_common: {
        conf: configByMode.visual.conf,
        iou: configByMode.visual.iou,
        outputKind: configByMode.visual.outputKind,
        overwrite: configByMode.visual.overwrite,
        scope: configByMode.visual.scope,
        ...rangeFields,
      },
    });
  }, [
    open,
    taskId,
    mode,
    textRows,
    pfClassId,
    pfMaxDet,
    configByMode,
    scopeRange,
    resolveHierarchy,
    hierarchyIou,
  ]);

  function clearForThisTask() {
    useDialogPrefs.getState().clearSmartFind(taskId);
    setMode("text");
    setTextRows([{ rid: `r-${Date.now()}`, classId: "", prompt: "" }]);
    setPicks({});
    setPfClassId("");
    setPfMaxDet(300);
    setConfigByMode({
      text: { ...DEFAULT_MODE_CONFIG },
      visual: { ...DEFAULT_MODE_CONFIG },
      prompt_free: { ...DEFAULT_MODE_CONFIG },
    });
    // v3.31 — reset hierarchy resolver to its smart default.
    setScopeRange({ from: "", to: "" });
    setResolveHierarchy(projectHasHierarchy);
    setHierarchyIou(0.7);
  }

  // Visual picker — read existing annotations from the editor's store.
  // The store is implicitly scoped to whichever frame the canvas is
  // currently rendering. Passed through to VisualReferencePicker so
  // the user's unsaved draws on the current asset show up immediately.
  const annotationsById = useAnnotations((s) => s.byId);

  // v3.24 — task-wide visual prompt picker. We need:
  //   * the list of assets in the task (for the thumbnail strip)
  //   * the list of annotations across the task (read-only refs from
  //     non-current assets — current asset reads from useAnnotations
  //     so unsaved edits are visible).
  // Both gated to ``mode === "visual"`` so the cost is paid only when
  // the visual picker is actually open.
  const taskAssetsQ = useQuery({
    queryKey: ["yoloe-task-assets", taskId],
    queryFn: () => assetsApi.listForTask(taskId!),
    enabled: !!taskId && open && mode === "visual",
    staleTime: 30_000,
  });

  // v3.31 — shared "task-assets" query used by the Range scope picker
  // and the canRun check. Same key the editor + AutoAnnotateDialog use
  // so React Query dedupes the request. Gated on ``open`` so we don't
  // pay the network cost when the dialog is closed.
  const rangeAssetsQ = useQuery({
    queryKey: ["task-assets", taskId ?? ""],
    queryFn: () => (taskId ? assetsApi.listForTask(taskId) : Promise.resolve([])),
    enabled: !!taskId && open,
    staleTime: 30_000,
  });
  const orderedAssetIds = useMemo(
    () => (rangeAssetsQ.data ?? []).map((a) => a.id),
    [rangeAssetsQ.data],
  );
  const rangeAssetIds = useMemo(
    () =>
      scope === "range"
        ? resolveScopeAssetIds("range", scopeRange, orderedAssetIds) ?? []
        : [],
    [scope, scopeRange, orderedAssetIds],
  );
  const taskAnnotationsQ = useQuery({
    queryKey: ["yoloe-task-annotations", taskId],
    queryFn: () => annotationsApi.listForTaskRaw(taskId!),
    enabled: !!taskId && open && mode === "visual",
    staleTime: 5_000,
  });

  // Group fetched annotations by source asset_id, keeping only
  // bbox / polygon kinds (the only useful visual references).
  interface RawRef {
    id: string;
    classId: string;
    kind: "bbox" | "polygon";
    geometry: Record<string, unknown>;
  }
  const annotationsByAssetId = useMemo(() => {
    const m = new Map<string, RawRef[]>();
    for (const a of taskAnnotationsQ.data ?? []) {
      if (!a.asset_id) continue;
      if (a.kind !== "bbox" && a.kind !== "polygon") continue;
      const arr = m.get(a.asset_id) ?? [];
      arr.push({
        id: a.id,
        classId: a.class_id,
        kind: a.kind as "bbox" | "polygon",
        geometry: a.geometry,
      });
      m.set(a.asset_id, arr);
    }
    return m;
  }, [taskAnnotationsQ.data]);

  // Pickable source assets — image-only, must have at least one
  // bbox/polygon. Videos are out of scope until per-frame picking is
  // built (see spec §8); the editor's current-asset path also
  // contributes its in-flight (unsaved) bboxes via useAnnotations.
  const pickableAssets = useMemo<Asset[]>(() => {
    const all = taskAssetsQ.data ?? [];
    const out: Asset[] = [];
    for (const a of all) {
      if (a.kind !== "image") continue;
      const refs = annotationsByAssetId.get(a.id) ?? [];
      // Include the current asset always (so the user's unsaved
      // bboxes from useAnnotations show up even if no rows have been
      // persisted yet).
      if (refs.length > 0 || a.id === assetId) {
        out.push(a);
      }
    }
    return out;
  }, [taskAssetsQ.data, annotationsByAssetId, assetId]);

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

  // Build the YOLOE wire payload (multi-source): one entry per
  // distinct source asset, each carrying its class-keyed bbox groups.
  // YOLOE's wire is bbox-only — flatten polygon picks to their
  // enclosing bbox at send time. The shared picker preserves the
  // original geometry so polygon-aware backends (SAM 3.1 PCS) can
  // use it; YOLOE just collapses it here.
  function buildVisualSources(): YoloeVisualSource[] | null {
    const bySource = new Map<
      string,
      Map<string, [number, number, number, number][]>
    >();
    for (const p of Object.values(picks)) {
      if (!p.classId) continue;
      const bbox: [number, number, number, number] =
        p.geometry.kind === "bbox"
          ? p.geometry.xyxy
          : (() => {
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
            })();
      const groupMap = bySource.get(p.assetId) ?? new Map();
      const bboxes = groupMap.get(p.classId) ?? [];
      bboxes.push(bbox);
      groupMap.set(p.classId, bboxes);
      bySource.set(p.assetId, groupMap);
    }
    if (bySource.size === 0) return null;
    return Array.from(bySource.entries()).map(([asset_id, groupMap]) => ({
      asset_id,
      groups: Array.from(groupMap.entries()).map(([class_id, bboxes]) => ({
        class_id,
        bboxes,
      })),
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

  // Picks summary across ALL sources — distinct counts for the
  // header chip ("N picks · M sources · K classes"). Picks with no
  // class assignment count toward `pickCount` but NOT toward
  // `classCount` (they block Run anyway).
  const picksSummary = useMemo(() => {
    const sourceIds = new Set<string>();
    const classIds = new Set<string>();
    let pickCount = 0;
    let unassigned = 0;
    for (const p of Object.values(picks)) {
      pickCount += 1;
      sourceIds.add(p.assetId);
      if (p.classId && p.classId.length > 0) classIds.add(p.classId);
      else unassigned += 1;
    }
    return {
      pickCount,
      sourceCount: sourceIds.size,
      classCount: classIds.size,
      unassigned,
    };
  }, [picks]);

  const canRun = useMemo(() => {
    if (!available) return false;
    if (scope === "all" && !taskId) return false;
    // v3.31 — range scope needs a task AND a non-empty resolved id
    // list (the clamp helper collapses invalid inputs to []).
    if (scope === "range") {
      if (!taskId) return false;
      if (rangeAssetIds.length === 0) return false;
    }
    if (mode === "text") {
      return textAvailable && textValidRows.length > 0;
    }
    if (mode === "visual") {
      // Every pick across every source must have a class assigned;
      // at least one pick total.
      if (picksSummary.pickCount === 0) return false;
      if (picksSummary.unassigned > 0) return false;
      // Visual mode needs the *target* asset (assetId for "this
      // image"; any of the task assets for "all" / "range").
      const targetOk = scope === "this" ? !!assetId : !!taskId;
      return textAvailable && targetOk;
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
    picksSummary.pickCount,
    picksSummary.unassigned,
    assetId,
    rangeAssetIds.length,
  ]);

  const run = useMutation({
    mutationFn: async () => {
      // v3.31 — single source of truth for the hierarchy flags. ``...spread``ed
      // into every yoloeApi call below so the toggle reaches sync + batch
      // surfaces uniformly. Only sends the field when the project has any
      // hierarchy AND the user opted in.
      const hierarchyExtras: { resolve_hierarchy?: boolean; hierarchy_iou?: number } =
        resolveHierarchy && projectHasHierarchy
          ? { resolve_hierarchy: true, hierarchy_iou: hierarchyIou }
          : {};
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
            ...hierarchyExtras,
          });
        }
        if (mode === "visual") {
          const sources = buildVisualSources();
          if (!sources) throw new Error("no_visual_reference");
          return await yoloeApi.visualPredict(assetId, {
            sources,
            conf,
            iou,
            overwrite,
            output_kind: outputKind,
            ...hierarchyExtras,
          });
        }
        return await yoloeApi.promptFreePredict(assetId, {
          annotate_as_class_id: pfClassId || null,
          conf,
          iou,
          max_detections: pfMaxDet || null,
          overwrite,
          output_kind: outputKind,
          ...hierarchyExtras,
        });
      }
      // Batch path — enqueue + return job_id (caller renders progress).
      // v3.31 — "range" routes through the same batch endpoint as "all"
      // and additionally carries the resolved asset_ids subset.
      if (!taskId) throw new Error("no_task");
      if (scope === "range" && rangeAssetIds.length === 0) {
        throw new Error("empty_range");
      }
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
        const sources = buildVisualSources();
        if (!sources) throw new Error("no_visual_reference");
        // Multi-source: each entry carries its own asset_id; the
        // worker fetches each source's bytes from MinIO ONCE before
        // the per-target loop and runs YOLOE per (source, target).
        params = {
          sources,
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
        ...(scope === "range" && rangeAssetIds.length > 0
          ? { asset_ids: rangeAssetIds }
          : {}),
        ...hierarchyExtras,
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
      const friendly = inferenceErrorMessage(err);
      if (friendly) {
        showToast(friendly, { variant: "error", duration: 5000 });
        return;
      }
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

  // v3.24.3 — Clear button. Resets ONLY the currently-active mode:
  // its config (conf/iou/output_kind/overwrite/scope) plus any mode-
  // specific selections (text rows, visual picks, prompt-free fields).
  // Other modes' state is preserved so the user doesn't lose work
  // they did in another tab.
  // v3.30 — replaced by ``clearForThisTask`` above, which also wipes
  // the persisted entry so reopening the dialog doesn't restore the
  // just-cleared setup.

  // Move an in-flight batch into the floating BackgroundJobsBar and
  // close the dialog. Used by:
  //   * the explicit ``Background`` button inside YoloeBatchProgress
  //   * the outside-click / ESC / X guard on the Dialog primitive
  //     (so a stray click never orphans a running job)
  function sendToBackground() {
    if (!runningJobId || !taskId) return false;
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
    return true;
  }

  const fallbackTrigger = (
    <button
      type="button"
      data-testid="yoloe-open"
      title="Find anything by text, visual example, or just look"
      aria-label="Smart Find"
      className={cn(
        // v3.24.5 — Smart Find pill matches the My Model (green) and
        // Auto-Annotate (blue) primary CTAs in shape (h-8 px-3, full
        // hover signature). Purple distinguishes it as the "open /
        // explore / anything" tool.
        // v3.24.12 — whitespace-nowrap + shrink-0 + label-collapse
        // mirrors the My Model and Auto-Annotate pills so the trio
        // never wraps mid-pill when the SAM controls or narrow
        // viewports squeeze the toolbar.
        "inline-flex h-8 shrink-0 items-center gap-1.5 px-3 rounded-[var(--radius-pill)] whitespace-nowrap",
        "bg-[#8b5cf6] text-white text-[12.5px] font-medium tracking-[0.2px]",
        "border border-[#8b5cf6]",
        "transition-all duration-[180ms] ease-out",
        "hover:bg-[#7c3aed] hover:border-white",
        "hover:shadow-[0_0_0_2px_#8b5cf6] hover:scale-[1.05]",
        "active:opacity-60 active:scale-100",
      )}
    >
      <ScanEye className="h-3.5 w-3.5" />
      <span className="hidden min-[1440px]:inline">Smart Find</span>
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
        // v3.23.6 — outside-click / ESC / X close while a batch is
        // running must NOT orphan the job. The user has three
        // legitimate intents at that point:
        //   * Cancel the run     — explicit Cancel button
        //   * Move it offscreen  — explicit Background button
        //   * Close the dialog   — implicit (outside-click / ESC / X)
        // The third case used to silently dismiss the dialog while
        // the worker kept running; the user lost the polling overlay
        // and had no way back to the job. Treat that case as
        // "background" so the floating bar takes over progress.
        if (!o && runningJobId && taskId) {
          sendToBackground();
          return;
        }
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
            Smart Find
            <span className="text-[11px] font-normal text-[color:var(--text-tertiary)]">
              YOLOE — Real-Time Seeing Anything
            </span>
          </DialogTitle>
          <DialogDescription>
            Find anything by text, visual example, or just look — open-vocab
            detection &amp; segmentation across this asset or every asset in
            the task.
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
            onBackground={sendToBackground}
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
                {/* v3.30 — bound the row list height so adding many
                    classes doesn't make the dialog grow taller than
                    the viewport. The "add" button + helper text stay
                    outside the scroll region for predictable layout. */}
                <div className="grid gap-1.5 max-h-[320px] overflow-y-auto pr-1">
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
                {/* Header — picks summary across ALL sources */}
                <div className="flex items-center justify-between">
                  <label className="text-[12px] font-medium text-[color:var(--text-primary)]">
                    Pick references &amp; assign a class to each
                  </label>
                  <span
                    className="text-[10.5px] text-[color:var(--text-tertiary)] font-mono tabular-nums"
                    data-testid="yoloe-visual-summary"
                  >
                    {picksSummary.pickCount} pick
                    {picksSummary.pickCount === 1 ? "" : "s"} ·{" "}
                    {picksSummary.sourceCount} source
                    {picksSummary.sourceCount === 1 ? "" : "s"} ·{" "}
                    {picksSummary.classCount} class
                    {picksSummary.classCount === 1 ? "" : "es"}
                    {picksSummary.unassigned > 0
                      ? ` · ${picksSummary.unassigned} need class`
                      : ""}
                  </span>
                </div>

                <VisualReferencePicker
                  assetId={assetId}
                  taskId={taskId}
                  classes={classes}
                  pickableAssets={pickableAssets}
                  annotationsByAssetId={annotationsByAssetId}
                  annotationsById={annotationsById}
                  picks={picks}
                  onPicksChange={setPicks}
                  loading={taskAssetsQ.isLoading || taskAnnotationsQ.isLoading}
                />

                <p className="text-[10.5px] text-[color:var(--text-tertiary)]">
                  Pick references from any image asset in this task and assign
                  each to a project class. Refs sharing a class strengthen
                  that class's visual signature; YOLOE finds visually similar
                  objects across the target asset(s).
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
              {/* v3.31 — scope picker now includes a "Range: from N to M"
                  option; the shared ScopePicker component owns the
                  3-radio layout + From/To number inputs. */}
              <ScopePicker
                name="yoloe-scope"
                mode={scope}
                onModeChange={(next) => patchActiveConfig({ scope: next })}
                range={scopeRange}
                onRangeChange={setScopeRange}
                totalAssets={orderedAssetIds.length}
                hasTask={!!taskId}
                hasAsset={!!assetId}
              />

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
                    onChange={(e) =>
                      patchActiveConfig({ conf: Number(e.target.value) })
                    }
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
                    onChange={(e) =>
                      patchActiveConfig({ iou: Number(e.target.value) })
                    }
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
                        onClick={() => patchActiveConfig({ outputKind: opt.v })}
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
                  onChange={(e) =>
                    patchActiveConfig({ overwrite: e.target.checked })
                  }
                  data-testid="yoloe-overwrite"
                />
                Replace existing annotations on this frame
              </label>

              {/* v3.31 — cross-class hierarchical NMS panel. */}
              <HierarchyResolverPanel
                name="yoloe"
                classes={classes}
                enabled={resolveHierarchy}
                onEnabledChange={setResolveHierarchy}
                iou={hierarchyIou}
                onIouChange={setHierarchyIou}
              />
            </div>

            <DialogFooter>
              {/* Clear button — left-aligned via mr-auto so the
                  positive/negative actions (Cancel, Run) stay grouped
                  on the right where the user expects to find them. */}
              <Button
                variant="ghost"
                size="md"
                onClick={clearForThisTask}
                data-testid="yoloe-clear"
                title="Reset every mode for this task (also wipes the saved prefs)"
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
                disabled={!canRun}
                loading={run.isPending}
                onClick={() => run.mutate()}
                data-testid="yoloe-run"
                title={
                  !canRun && mode === "visual" && picksSummary.unassigned > 0
                    ? `${picksSummary.unassigned} picked reference${picksSummary.unassigned === 1 ? "" : "s"} need a class`
                    : !canRun && mode === "visual" && picksSummary.pickCount === 0
                      ? "Pick at least one reference and assign it a class"
                      : !canRun && mode === "text" && textValidRows.length === 0
                        ? "Add at least one row with both a class and a prompt"
                        : undefined
                }
              >
                {scope === "this"
                  ? "Run"
                  : scope === "range"
                    ? `Run on ${rangeAssetIds.length || 0} asset${rangeAssetIds.length === 1 ? "" : "s"}`
                    : "Run on all assets"}
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
        {status === "running" || status === "pending" || status === "waiting_for_gpu" ? (
          <Loader2 className="h-4 w-4 mt-0.5 text-[color:var(--accent)] animate-spin" />
        ) : status === "failed" || status === "canceled" ? (
          <AlertTriangle className="h-4 w-4 mt-0.5 text-[color:var(--danger)]" />
        ) : (
          <CheckCircle2 className="h-4 w-4 mt-0.5 text-[color:var(--success)]" />
        )}
        <div className="grid gap-0.5 flex-1">
          <div className="text-[12.5px] font-medium">
            {status === "waiting_for_gpu"
              ? "Waiting for GPU…"
              : `YOLOE batch ${status === "running" ? "running" : status}`}
          </div>
          <div className="text-[11px] text-[color:var(--text-secondary)] font-mono tabular-nums">
            {done}/{total}
            {failed > 0 ? ` · ${failed} failed` : ""}
            {status === "waiting_for_gpu"
              ? " · another job is on the GPU"
              : ""}
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
