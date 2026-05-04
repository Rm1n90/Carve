// Armin Mehri — mehri.armin@gmail.com
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  MousePointer2,
  Wand2,
  Square,
  Pentagon,
  Brush,
  Tag,
  Eye,
  Filter,
  Maximize,
  Save,
  Sparkles,
  ChevronDown,
  Plus,
  Minus,
  Undo2,
  Redo2,
  Check,
  Loader2,
  AlertTriangle,
  Settings,
  X,
  Eraser,
  MoreHorizontal,
  Keyboard,
  Info,
} from "lucide-react";
import { EditorSettingsDialog } from "@/components/annotation/EditorSettingsDialog";
import { FilterBuilderDialog } from "@/components/annotation/FilterBuilderDialog";
import { SamVariantSwitcher } from "@/components/annotation/SamVariantSwitcher";
import { AutoAnnotateDialog } from "@/components/annotation/AutoAnnotateDialog";
import { FrameExtractDialog } from "@/components/annotation/FrameExtractDialog";
import { useFilter } from "@/state/annotationFilter";
import { hasMeaningfulRules } from "@/lib/annotation-filter";
import { useTool, type ToolName, type VisibilityFlags } from "@/state/tool";
import { useAnnotations } from "@/state/annotations";
import { Tooltip } from "@/components/ui/Tooltip";
import { Kbd } from "@/components/ui/Kbd";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/Popover";
import { SaveIndicator } from "@/components/annotation/SaveIndicator";
import {
  modelsApi,
  weightsApi,
  inferenceApi,
  type Weight,
  type MappingSuggestion,
  type ClassOverrides,
  type BatchPredictProgress,
} from "@/api/phase2";
import { projectsApi, type Project } from "@/api/projects";
import { showToast } from "@/lib/toast";
import {
  newAnnotationIdsSince,
  runSamPostProcess,
  snapshotAnnotationIds,
  type PostProcessMode,
} from "@/lib/samPostProcess";
import { cn } from "@/lib/cn";
import { useOptionalConfirm } from "@/components/ui/ConfirmDialog";

const PREDICT_CONF_KEY = "carve.predict.minConfidence";
const DEFAULT_PREDICT_CONFIDENCE = 0.4;
// v3.7.5 — IOU (NMS) threshold persisted alongside confidence so the user's
// preferred dial sticks across sessions. Default mirrors the Ultralytics
// default of 0.7.
const PREDICT_IOU_KEY = "carve.predict.iou";
const DEFAULT_PREDICT_IOU = 0.7;
// v3.3 Issue 4 — last-used YOLO weight per project. Keyed so switching
// projects shows the right preselection without leaking across boundaries.
const LAST_WEIGHT_KEY_PREFIX = "carve.editor.lastWeight.";
// v3.5 Phase F3 — last-used class overrides per (weight, task) pair.
// Mapping is intrinsically per-task, so the key includes both ids and
// pre-fills the dropdowns the next time the user re-opens the popover
// in the same task with the same weight.
const OVERRIDES_KEY_PREFIX = "carve.editor.overrides.";
// Sentinel for the "None / skip" option in the per-weight-class dropdown.
// Radix Select disallows empty-string values; we translate this token to
// `null` at the API boundary.
const OVERRIDE_SKIP = "__skip__";

function lastWeightKey(projectId: string): string {
  return `${LAST_WEIGHT_KEY_PREFIX}${projectId}`;
}

function loadLastWeight(projectId: string): string | null {
  try {
    return window.localStorage.getItem(lastWeightKey(projectId));
  } catch {
    return null;
  }
}

function saveLastWeight(projectId: string, weightId: string): void {
  try {
    window.localStorage.setItem(lastWeightKey(projectId), weightId);
  } catch {
    /* localStorage may be unavailable (private mode) — non-fatal */
  }
}

function overridesKey(weightId: string, taskId: string): string {
  return `${OVERRIDES_KEY_PREFIX}${weightId}.${taskId}`;
}

function loadOverrides(
  weightId: string,
  taskId: string,
): Record<string, string | null> | null {
  try {
    const raw = window.localStorage.getItem(overridesKey(weightId, taskId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, string | null>;
    }
    return null;
  } catch {
    return null;
  }
}

function saveOverrides(
  weightId: string,
  taskId: string,
  overrides: Record<string, string | null>,
): void {
  try {
    window.localStorage.setItem(
      overridesKey(weightId, taskId),
      JSON.stringify(overrides),
    );
  } catch {
    /* localStorage may be unavailable (private mode) — non-fatal */
  }
}

function loadStoredConfidence(): number {
  try {
    const raw = window.localStorage.getItem(PREDICT_CONF_KEY);
    if (!raw) return DEFAULT_PREDICT_CONFIDENCE;
    const n = Number(raw);
    if (!Number.isFinite(n)) return DEFAULT_PREDICT_CONFIDENCE;
    return Math.max(0, Math.min(1, n));
  } catch {
    return DEFAULT_PREDICT_CONFIDENCE;
  }
}

// v3.7.5 — same shape as loadStoredConfidence; falls back to 0.7 when
// localStorage is unavailable or the value is non-finite.
function loadStoredIou(): number {
  try {
    const raw = window.localStorage.getItem(PREDICT_IOU_KEY);
    if (!raw) return DEFAULT_PREDICT_IOU;
    const n = Number(raw);
    if (!Number.isFinite(n)) return DEFAULT_PREDICT_IOU;
    return Math.max(0, Math.min(1, n));
  } catch {
    return DEFAULT_PREDICT_IOU;
  }
}

interface ToolDef {
  name: ToolName;
  label: string;
  hotkey: string;
  icon: ReactNode;
}

const TOOLS: ToolDef[] = [
  { name: "cursor", label: "Drag", hotkey: "V", icon: <MousePointer2 className="h-[18px] w-[18px]" /> },
  { name: "sam", label: "Smart (SAM)", hotkey: "S", icon: <Wand2 className="h-[18px] w-[18px]" /> },
  { name: "bbox", label: "Bounding box", hotkey: "B", icon: <Square className="h-[18px] w-[18px]" /> },
  { name: "polygon", label: "Polygon", hotkey: "P", icon: <Pentagon className="h-[18px] w-[18px]" /> },
  { name: "mask", label: "Mask brush", hotkey: "M", icon: <Brush className="h-[18px] w-[18px]" /> },
  { name: "tag", label: "Tag", hotkey: "T", icon: <Tag className="h-[18px] w-[18px]" /> },
];

interface EditorToolbarProps {
  onSave: () => void;
  isSaving: boolean;
  hasError: boolean;
  dirtyCount: number;
  onFitToScreen?: () => void;
  onZoomIn?: () => void;
  onZoomOut?: () => void;
  onZoomTo?: (pct: number) => void;
  onZoomActual?: () => void;
  onUndo?: () => void;
  onRedo?: () => void;
  zoomPct?: number;
  /** Only present when an asset is open. */
  projectId?: string;
  taskId?: string;
  assetId?: string;
  /**
   * v3.5 Phase E — true when the open asset is a multi-frame video.
   * Gates the SAM "Track" mode chip; tracking has no meaning on a
   * single-frame image asset because the predictor needs more than one
   * frame to propagate masks across.
   */
  isVideo?: boolean;
  /** Called when YOLO predict completes; lets the page reload annotations. */
  onAfterYoloPredict?: () => void;
  /**
   * v3.8 Phase 3.5 — project classes. Passed through to the
   * Auto-annotate dialog so its checklist can show name + color +
   * stored ``text_prompt`` per class.
   */
  classes?: import("@/api/classes").ClassRow[];
  /**
   * Optional slot rendered before the Settings button in the right
   * cluster. Used by the editor page to inline the saved-views menu
   * next to the gear so it stops occupying its own row above the
   * canvas (Phase 9 follow-up — reclaim canvas space).
   */
  rightSlot?: ReactNode;
}

function ToolButton({
  active,
  label,
  hotkey,
  onClick,
  children,
}: {
  active: boolean;
  label: string;
  hotkey: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`${label} (${hotkey})`}
      aria-pressed={active}
      title={`${label} — ${hotkey}`}
      className={cn(
        "grid h-8 w-8 place-items-center rounded-[var(--radius-md)] transition-all duration-150",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]",
        active
          ? "glass-active-ring"
          : "text-[color:var(--text-secondary)] hover:bg-[var(--glass-bg-subtle)] hover:text-[color:var(--text-primary)] hover:shadow-[inset_0_1px_0_var(--glass-highlight)]",
      )}
    >
      {children}
    </button>
  );
}

/**
 * Compact SAM variant picker for the editor toolbar. The trigger shows
 * the currently active variant; the popover wraps the shared
 * `<SamVariantSwitcher variant="compact" />` which handles the real
 * runtime switch (POST /models/sam-active). v3.5 Phase B — was
 * previously read-only; now actually swaps.
 */
function SamModelPicker() {
  const q = useQuery({
    queryKey: ["sam-active"],
    queryFn: () => modelsApi.samActive(),
  });
  const active = q.data?.active ?? "sam2.1-base+";

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="sam-model-picker"
          aria-label={`SAM model: ${active}`}
          title={`SAM model: ${active}`}
          className={cn(
            "inline-flex items-center gap-1 h-8 pl-2 pr-1.5 rounded-[var(--radius-sm)]",
            "text-[12px] tracking-tight",
            "text-[color:var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[color:var(--text-primary)]",
          )}
        >
          <Sparkles className="h-3.5 w-3.5 text-[color:var(--accent)]" />
          <span className="hidden md:inline tabular-nums">{active}</span>
          <ChevronDown className="h-3 w-3" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="min-w-[300px] p-1">
        <SamVariantSwitcher variant="compact" />
      </PopoverContent>
    </Popover>
  );
}

/**
 * v3.7 Phase 2 Issue 2 — imperative API exposed by ``YoloPredictButton``
 * so the toolbar's Cmd/Ctrl+Enter shortcut can fire a quick predict
 * without the user opening the popover. The predict button owns the
 * weight / overrides / confidence state, so the toolbar delegates the
 * pre-flight + fire decision to ``quickPredict``.
 */
export interface YoloPredictHandle {
  /** Fire a predict with the currently active scope ("asset" by
   *  default). Falls back to opening the popover when prerequisites
   *  (weight / class mapping) are missing — and emits a contextual
   *  toast so the user understands why nothing happened. */
  quickPredict: () => void;
  /** Open the popover programmatically (used by missing-config UX). */
  openPopover: () => void;
}

const YoloPredictButton = forwardRef<
  YoloPredictHandle,
  {
    projectId?: string;
    taskId?: string;
    assetId?: string;
    onAfter?: () => void;
  }
>(function YoloPredictButton({ projectId, taskId, assetId, onAfter }, ref) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [overwrite, setOverwrite] = useState(false);
  // Plan-17 Phase 2 — SAM post-processing. ``samPost`` toggles the
  // pass on/off; mode is auto-derived from the selected weight's
  // task_kind ('detect' → to-polygon, 'segment' → refine). The user
  // can override the mode in the popover. Progress is reported
  // inline below the predict actions.
  const [samPost, setSamPost] = useState(false);
  const [samPostProgress, setSamPostProgress] = useState<{
    done: number;
    total: number;
    failed: number;
  } | null>(null);
  // Set on click and inspected in onSuccess so the post-process loop
  // only refines annotations the predict pass produced (not the
  // pre-existing ones on this asset). Cleared on completion.
  const beforePredictIdsRef = useRef<Set<string> | null>(null);
  const [confidence, setConfidence] = useState<number>(() => loadStoredConfidence());
  // v3.7.5 — IOU (NMS) threshold dial. Same persistence shape as
  // confidence so the user's preferred value sticks across sessions.
  const [iou, setIou] = useState<number>(() => loadStoredIou());
  // v3.5 Phase F3 — per-weight-class binding picked by the user in the
  // disclosure. Keyed by `weight_class_idx` (string) so the wire shape
  // matches the API. `null` means "skip this weight class on predict".
  const [overrides, setOverrides] = useState<Record<string, string | null>>({});
  const [overridesExpanded, setOverridesExpanded] = useState(false);
  // v3.7 Phase 2 Issue 1 — predict scope. "asset" is the existing flow
  // (single asset). "task" enqueues the RQ batch over every asset in
  // the task and opens the progress overlay below.
  const [scope, setScope] = useState<"asset" | "task">("asset");
  // v3.7 Phase 2 Issue 1 — active batch job. Null when no batch is in
  // flight. Renders the <BatchPredictProgressOverlay/> when set.
  const [batchJobId, setBatchJobId] = useState<string | null>(null);
  const qc = useQueryClient();

  // Persist confidence so the user's preferred threshold sticks across
  // sessions. Plain string-encoded float 0..1.
  // v2.9 P2 E12 — debounce by ~200ms so dragging the slider doesn't write
  // localStorage on every step.
  useEffect(() => {
    const t = window.setTimeout(() => {
      try {
        window.localStorage.setItem(PREDICT_CONF_KEY, String(confidence));
      } catch {
        /* localStorage may be unavailable in some browsers (private mode) */
      }
    }, 200);
    return () => window.clearTimeout(t);
  }, [confidence]);

  // v3.7.5 — persist IOU threshold the same way confidence is persisted.
  // Debounced 200ms so dragging the slider doesn't write on every step.
  useEffect(() => {
    const t = window.setTimeout(() => {
      try {
        window.localStorage.setItem(PREDICT_IOU_KEY, String(iou));
      } catch {
        /* localStorage may be unavailable (private mode) — non-fatal */
      }
    }, 200);
    return () => window.clearTimeout(t);
  }, [iou]);

  // v3.7 Phase 2 Issue 2 — weight list is now eager (not gated on
  // ``open``) so the Cmd/Ctrl+Enter shortcut can pre-flight the
  // "weight selected?" check without forcing the popover to open
  // first. `staleTime` keeps the network footprint low.
  const wq = useQuery<Weight[]>({
    queryKey: ["weights", projectId],
    queryFn: () => (projectId ? weightsApi.listForProject(projectId) : Promise.resolve([])),
    enabled: !!projectId,
    staleTime: 30_000,
  });

  // v3.3 Issue 3b — workspace-wide weights, used to populate the empty
  // state with a cross-project hint. Only fetched when the popover is
  // open AND the current project has no weights of its own, so we don't
  // incur an extra request on the happy path.
  const projectHasWeights = (wq.data?.length ?? 0) > 0;
  const wsWq = useQuery<Weight[]>({
    queryKey: ["weights", "workspace", "for-empty-hint"],
    queryFn: () => weightsApi.listWorkspace(),
    enabled: open && !projectHasWeights && !!projectId && !wq.isLoading,
  });

  // Pull project names for the cross-project hint. Fetched once and
  // cached by react-query — same key as everywhere else in the app.
  const projectsQ = useQuery<Project[]>({
    queryKey: ["projects"],
    queryFn: () => projectsApi.list(),
    enabled: open && !projectHasWeights,
    staleTime: 60_000,
  });
  const projectNameById = (() => {
    const m = new Map<string, string>();
    for (const p of projectsQ.data ?? []) m.set(p.id, p.name);
    return m;
  })();

  // v3.3 Issue 4 / v3.7 Phase 2 Issue 2 — pre-select the project's
  // last-used weight (if still present) or fall back to the project
  // default. Now runs as soon as the weight list lands (no longer
  // gated on ``open``) so the Cmd/Ctrl+Enter shortcut can find a
  // default without forcing the user to open the popover first.
  // Only fires when nothing is currently selected so a manual pick
  // is never overwritten.
  useEffect(() => {
    if (selected !== null) return;
    const weights = wq.data ?? [];
    if (weights.length === 0) return;
    if (projectId) {
      const last = loadLastWeight(projectId);
      if (last && weights.some((w) => w.id === last)) {
        setSelected(last);
        return;
      }
    }
    const def = weights.find((w) => w.is_default);
    if (def) {
      setSelected(def.id);
    }
  }, [selected, wq.data, projectId]);

  // v3.5 Phase F3 / v3.7 Phase 2 Issue 2 — fetch class-mapping
  // suggestions once the user picks a weight. Now eager (not gated on
  // ``open``) so the Cmd/Ctrl+Enter shortcut can pre-flight the
  // "any classes mapped?" check without opening the popover. Read-only
  // on the API; computed per `(weight, task)` from case-insensitive
  // name match against the task's allowed classes.
  const sugQ = useQuery({
    queryKey: ["mapping-suggestions", selected, taskId],
    queryFn: () =>
      selected && taskId
        ? weightsApi.getMappingSuggestions(selected, taskId)
        : Promise.resolve({ suggestions: [] }),
    enabled: !!selected && !!taskId,
    staleTime: 30_000,
  });
  const suggestions: MappingSuggestion[] = sugQ.data?.suggestions ?? [];

  // v3.5 Phase F3 / v3.7 Phase 2 Issue 2 — once suggestions land, seed
  // the override state: first check the per-`(weight, task)`
  // localStorage cache (so the user's last picks pre-fill), otherwise
  // fall back to the auto-name matched suggestion. Skipping (None) is
  // represented by `null`. No longer gated on ``open`` so the
  // Cmd/Ctrl+Enter quick-predict path can read overrides immediately
  // after the user lands on the page.
  useEffect(() => {
    if (!selected || !taskId) return;
    if (suggestions.length === 0) {
      setOverrides({});
      return;
    }
    const stored = loadOverrides(selected, taskId);
    const next: Record<string, string | null> = {};
    for (const s of suggestions) {
      const key = String(s.weight_class_idx);
      if (stored && key in stored) {
        next[key] = stored[key];
      } else {
        next[key] = s.suggested_project_class_id;
      }
    }
    setOverrides(next);
    // Reset the disclosure expansion when the weight changes so the
    // popover starts collapsed every time.
    setOverridesExpanded(false);
    // Only re-run when the meaningful inputs change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, taskId, sugQ.data]);

  const matchedCount = suggestions.reduce((acc, s) => {
    const v = overrides[String(s.weight_class_idx)];
    return acc + (v !== null && v !== undefined ? 1 : 0);
  }, 0);

  // v3.7.2 — pre-flight: when suggestions are loaded but ZERO weight
  // classes are mapped to a project class (auto-suggestion null AND
  // override null/undefined for every suggestion), the predict would
  // skip every detection. Critical for the yolov8n-vs-3-class scenario
  // that triggered the data-loss bug. Disable the Predict button to
  // force the user to map at least one class first.
  const noClassesMapped =
    !!selected &&
    !!taskId &&
    suggestions.length > 0 &&
    matchedCount === 0;

  // v3.7.2 — confirmation dialog for the destructive overwrite+batch
  // combination. The user just learned the safety net (existing
  // annotations are preserved on no-match assets) but they should still
  // explicitly confirm replacing annotations across an entire task.
  // Uses the non-throwing variant so legacy test wrappers that don't
  // mount <ConfirmProvider> still render the toolbar; production has
  // the provider mounted in main.tsx.
  const confirm = useOptionalConfirm();

  const m = useMutation({
    mutationFn: (weightId: string) => {
      if (!assetId) return Promise.reject(new Error("no asset"));
      // v3.5 Phase F3 — only send overrides when they actually differ
      // from the auto-suggested mapping, so legacy callers keep their
      // pure name-match behavior on the wire and tests don't see noise.
      const wireOverrides: ClassOverrides = {};
      for (const s of suggestions) {
        const key = String(s.weight_class_idx);
        const picked = overrides[key];
        // Treat undefined as "no entry" — let backend name-match handle it.
        if (picked === undefined) continue;
        if (picked !== s.suggested_project_class_id) {
          wireOverrides[key] = picked;
        }
      }
      return inferenceApi.predictYolo(
        assetId,
        weightId,
        overwrite,
        confidence,
        Object.keys(wireOverrides).length > 0 ? wireOverrides : undefined,
        iou,
      );
    },
    onSuccess: (res, weightId) => {
      const created = res?.annotations_created ?? res?.count ?? 0;
      const skipped = res?.skipped_count ?? 0;
      const unmappedClasses = Object.keys(res?.skipped_by_class ?? {});
      // v3.7.2 — overwrite=true was requested but suppressed because
      // the new prediction yielded zero annotations. Tell the user
      // their existing annotations were preserved (data-loss prevention).
      if (res?.overwrite_skipped) {
        showToast(
          "Overwrite skipped — no matching detections. Existing annotations were preserved.",
          { variant: "warning", duration: 6000 },
        );
      } else if (created === 0 && skipped === 0) {
        showToast(
          `No detections at confidence ${(confidence * 100).toFixed(0)}%`,
          { variant: "warning" },
        );
      } else if (skipped > 0) {
        // v3.3 Issue 3c — surface the per-class skipped tally so the user
        // knows their weight has classes that don't bind to project classes.
        // Direct them to the YOLO weight detail panel to remap.
        const list =
          unmappedClasses.length > 0
            ? ` (unmapped: ${unmappedClasses.join(", ")})`
            : "";
        showToast(
          `Created ${created} annotations. Skipped ${skipped} detections${list}.`,
          { variant: "warning", duration: 5000 },
        );
      } else {
        showToast(`Created ${created} annotations from predictions`, {
          variant: "success",
        });
      }
      // v3.3 Issue 4 — remember the last-used weight per project so the
      // next predict in this project pre-selects it.
      if (projectId) {
        saveLastWeight(projectId, weightId);
      }
      // v3.5 Phase F3 — persist the user's class-override picks per
      // (weight, task) so the next predict in this same task pre-fills
      // the dropdowns from the cache instead of from auto-name match.
      if (taskId && Object.keys(overrides).length > 0) {
        saveOverrides(weightId, taskId, overrides);
      }
      onAfter?.();
      // Plan-17 Phase 2 — opt-in SAM post-processing pass. Runs ONLY
      // when the user ticked the box and there's a snapshot to diff
      // against. Sequential so the GPU mutex doesn't queue dozens of
      // requests; progress is reported into ``samPostProgress`` for
      // the inline bar in the popover.
      const beforeIds = beforePredictIdsRef.current;
      beforePredictIdsRef.current = null;
      if (samPost && beforeIds && assetId) {
        // Wait briefly for the parent's annotations refetch (kicked
        // off by ``onAfter``) to settle into the Zustand store.
        setTimeout(() => {
          const newIds = newAnnotationIdsSince(beforeIds);
          if (newIds.length === 0) {
            setOpen(false);
            return;
          }
          // Plan-17 Phase 2 — mode is auto-derived from the selected
          // weight's task_kind:
          //   detect  → to-polygon  (BBox  → SAM polygon)
          //   segment → refine      (Poly  → SAM-refined polygon)
          // The 4-button override segmented control was removed in
          // favour of this strict per-weight mapping after user
          // feedback that the override was confusing more than it
          // was helping.
          const picked = weights.find((w) => w.id === weightId);
          const mode: PostProcessMode =
            picked?.task_kind === "detect" ? "to-polygon" : "refine";
          setSamPostProgress({ done: 0, total: newIds.length, failed: 0 });
          void runSamPostProcess({
            assetId,
            frameId: null,
            annotationIds: newIds,
            mode,
            onProgress: setSamPostProgress,
          })
            .then((result) => {
              if (result.succeeded > 0) {
                showToast(
                  `SAM ${mode === "to-polygon" ? "→ polygon" : "refine"}: ${result.succeeded}/${newIds.length}${result.failed > 0 ? ` (${result.failed} failed)` : ""}.`,
                  { variant: "success" },
                );
              } else if (result.failed > 0) {
                showToast(
                  `SAM post-process failed for all ${result.failed} annotations.`,
                  { variant: "error" },
                );
              }
              setSamPostProgress(null);
              setOpen(false);
            })
            .catch((err: unknown) => {
              const detail =
                (err as { message?: string })?.message ||
                "SAM post-process failed.";
              showToast(detail, { variant: "error", duration: 5000 });
              setSamPostProgress(null);
              setOpen(false);
            });
        }, 600);
      } else {
        setOpen(false);
      }
    },
    onError: (err: unknown) => {
      const errObj = err as {
        response?: { status?: number; data?: { detail?: string; error?: string } };
      };
      const status = errObj?.response?.status;
      const detail = errObj?.response?.data?.detail ?? errObj?.response?.data?.error;
      if (status === 503 || detail === "model_service_unreachable") {
        showToast("Model service is not running.", {
          variant: "error",
          duration: 5000,
        });
        setOpen(false);
      } else if (status === 404 && detail === "weight_not_found") {
        showToast("Select a weight first.", { variant: "error" });
      } else if (status === 502 || detail === "model_service_failed") {
        showToast("Model service rejected the request.", {
          variant: "error",
          duration: 5000,
        });
      } else {
        showToast("Predict failed — please try again.", { variant: "error" });
      }
    },
  });

  // v3.7 Phase 2 Issue 1 — build the wire-shape ``class_overrides`` map
  // shared by single-asset and batch paths. Only includes entries that
  // diverge from the auto-suggestion so we don't pollute the wire with
  // redundant data.
  const buildWireOverrides = useCallback((): ClassOverrides | undefined => {
    const wireOverrides: ClassOverrides = {};
    for (const s of suggestions) {
      const key = String(s.weight_class_idx);
      const picked = overrides[key];
      if (picked === undefined) continue;
      if (picked !== s.suggested_project_class_id) {
        wireOverrides[key] = picked;
      }
    }
    return Object.keys(wireOverrides).length > 0 ? wireOverrides : undefined;
  }, [overrides, suggestions]);

  // v3.7 Phase 2 Issue 1 — batch path mutation. Returns the ``job_id``
  // on success; the caller stores it in ``batchJobId`` to surface the
  // progress overlay. Errors fall back to a single toast — the same
  // shape as the single-asset error branch.
  const batchM = useMutation({
    mutationFn: (weightId: string) => {
      if (!taskId) return Promise.reject(new Error("no task"));
      return inferenceApi.predictYoloBatch(
        taskId,
        weightId,
        overwrite,
        confidence,
        buildWireOverrides(),
        iou,
      );
    },
    onSuccess: (res, weightId) => {
      // Persist last-used weight + overrides identically to the
      // single-asset path so the next predict (any scope) pre-fills.
      if (projectId) saveLastWeight(projectId, weightId);
      if (taskId && Object.keys(overrides).length > 0) {
        saveOverrides(weightId, taskId, overrides);
      }
      setOpen(false);
      const jobId = res?.job_id;
      if (jobId) {
        setBatchJobId(jobId);
      } else {
        // Backend was reachable but didn't return a job_id (shouldn't
        // happen in production; defensive fallback for local Redis-down
        // setups). Surface a warning so the user doesn't think the
        // predict actually ran.
        showToast(
          "Batch predict enqueue did not return a job id — check Redis.",
          { variant: "warning", duration: 5000 },
        );
      }
    },
    onError: (err: unknown) => {
      const errObj = err as {
        response?: {
          status?: number;
          data?: { detail?: string; error?: string };
        };
      };
      const status = errObj?.response?.status;
      const detail =
        errObj?.response?.data?.detail ?? errObj?.response?.data?.error;
      if (status === 503 || detail === "model_service_unreachable") {
        showToast("Model service is not running.", {
          variant: "error",
          duration: 5000,
        });
      } else if (status === 404 && detail === "weight_not_found") {
        showToast("Select a weight first.", { variant: "error" });
      } else {
        showToast("Batch predict failed — please try again.", {
          variant: "error",
        });
      }
    },
  });

  async function handlePredict() {
    if (!selected) {
      showToast("Select a weight first.", { variant: "error" });
      return;
    }
    if (scope === "task") {
      if (!taskId) {
        showToast("No task open.", { variant: "error" });
        return;
      }
      // v3.7.2 — confirm the destructive overwrite+batch combination so
      // the user can't accidentally replace annotations across every
      // asset in a task. The backend safety net preserves existing rows
      // on assets with zero matching detections, so the UI surfaces
      // that nuance in the dialog copy.
      if (overwrite) {
        const ok = await confirm({
          title: "Replace existing annotations across the task?",
          description:
            "This will REPLACE existing annotations on every asset in this task that has a matching detection. Existing annotations on assets with no matches will be preserved. Continue?",
          confirmLabel: "Replace and predict",
          cancelLabel: "Cancel",
          variant: "danger",
        });
        if (!ok) return;
      }
      batchM.mutate(selected);
      return;
    }
    if (!assetId) {
      showToast("No asset open.", { variant: "error" });
      return;
    }
    if (samPost) {
      // Plan-17 Phase 2 — snapshot the current ids so onSuccess can
      // diff and find only the predict-produced ones for refinement.
      beforePredictIdsRef.current = snapshotAnnotationIds();
    } else {
      beforePredictIdsRef.current = null;
    }
    m.mutate(selected);
  }

  // v3.7 Phase 2 Issue 2 — quick-predict path used by the
  // Cmd/Ctrl+Enter keyboard shortcut. Mirrors handlePredict but with
  // contextual missing-config UX so the user lands directly on the
  // popover (with the right disclosure expanded) when prerequisites
  // aren't met. Reads from the same cached queries as the popover.
  const quickPredict = useCallback(() => {
    if (!projectId) {
      showToast("Open a project to predict.", { variant: "error" });
      return;
    }
    const weightsList = wq.data ?? [];
    if (weightsList.length === 0) {
      showToast(
        "No YOLO weight available — upload one in YOLO Models.",
        { variant: "error", duration: 5000 },
      );
      setOpen(true);
      return;
    }
    if (!selected) {
      showToast("Pick a weight first", { variant: "error" });
      setOpen(true);
      return;
    }
    if (taskId && suggestions.length > 0) {
      // matchedCount excludes nulls (skipped weight classes). When zero,
      // there is no class binding for this predict run — the backend
      // would silently skip everything.
      const matched = suggestions.reduce((acc, s) => {
        const v = overrides[String(s.weight_class_idx)];
        return acc + (v !== null && v !== undefined ? 1 : 0);
      }, 0);
      if (matched === 0) {
        showToast("No classes mapped — open class mapping", {
          variant: "error",
          duration: 5000,
        });
        setOpen(true);
        setOverridesExpanded(true);
        return;
      }
    }
    if (scope === "task" && !taskId) {
      showToast("No task open.", { variant: "error" });
      return;
    }
    if (scope === "asset" && !assetId) {
      showToast("No asset open.", { variant: "error" });
      return;
    }
    // All prerequisites met — fire the predict directly.
    if (scope === "task") {
      batchM.mutate(selected);
    } else {
      if (samPost) {
        beforePredictIdsRef.current = snapshotAnnotationIds();
      } else {
        beforePredictIdsRef.current = null;
      }
      m.mutate(selected);
    }
  }, [
    projectId,
    wq.data,
    selected,
    taskId,
    assetId,
    suggestions,
    overrides,
    scope,
    batchM,
    m,
    samPost,
  ]);

  // v3.7 Phase 2 Issue 2 — expose ``quickPredict`` + ``openPopover`` to
  // the parent toolbar so its keyboard handler can fire a predict
  // without owning weight/overrides/scope state itself.
  useImperativeHandle(
    ref,
    () => ({
      quickPredict,
      openPopover: () => setOpen(true),
    }),
    [quickPredict],
  );

  const weights = wq.data ?? [];
  // Plan-17 Phase 2 — the selected weight at render time so the
  // post-process label can match its task_kind.
  const selectedWeight = selected
    ? weights.find((w) => w.id === selected) ?? null
    : null;
  const samPostLabel =
    selectedWeight?.task_kind === "detect"
      ? "Convert BBox to Polygon (SAM)"
      : selectedWeight?.task_kind === "segment"
        ? "Refine with SAM after Predict"
        : null;
  // v3.7 Phase 2 Issue 1 — single-asset scope still needs an open
  // asset, but the batch ("All assets in task") scope only needs a
  // project context. Don't grey out the trigger when ``scope === "task"``
  // and the user happens to be on a project page without an asset yet.
  const disabled = !projectId || (scope === "asset" && !assetId);
  const isPredicting = m.isPending || batchM.isPending;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="yolo-predict-trigger"
          aria-label="Open YOLO predict"
          title="Predict with YOLO weight"
          disabled={disabled || isPredicting}
          className={cn(
            "inline-flex h-8 items-center gap-1.5 px-3 rounded-full",
            "bg-[var(--success)] text-white text-[12.5px] font-medium tracking-tight",
            "hover:bg-[var(--success-hover)] transition-colors",
            "disabled:bg-[var(--bg-subtle)] disabled:text-[color:var(--text-tertiary)] disabled:cursor-not-allowed",
          )}
        >
          {isPredicting ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Sparkles className="h-3.5 w-3.5" />
          )}
          {isPredicting ? "Predicting…" : "Predict"}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="min-w-[320px] p-2">
        <p className="px-1 py-1 text-[10.5px] uppercase tracking-[0.10em] text-[color:var(--text-tertiary)]">
          YOLO weight
        </p>
        <div className="grid gap-1 max-h-[200px] overflow-y-auto pr-1">
          {wq.isLoading && (
            <p className="px-2 py-2 text-[12px] text-[color:var(--text-tertiary)] italic">
              Loading weights…
            </p>
          )}
          {!wq.isLoading && weights.length === 0 && (
            <div className="grid gap-1.5">
              <p
                data-testid="yolo-empty-hint"
                className="px-2 py-2 text-[12px] text-[color:var(--text-tertiary)] italic"
              >
                No weights uploaded for this project yet.
              </p>
              {/* v3.3 Issue 3b — show up to 5 workspace-wide weights as
                  disabled rows so the user can see what exists elsewhere
                  and switch projects to use one. */}
              {(wsWq.data ?? []).length > 0 && (
                <div
                  data-testid="yolo-cross-project-hint"
                  className="grid gap-1 pt-1 mt-1 border-t border-[var(--border-subtle)]"
                >
                  <p className="px-2 pt-1 text-[10.5px] uppercase tracking-[0.10em] text-[color:var(--text-tertiary)]">
                    Available in other projects
                  </p>
                  {(wsWq.data ?? []).slice(0, 5).map((w) => {
                    const projName = w.project_id
                      ? (projectNameById.get(w.project_id) ?? "another project")
                      : "workspace";
                    return (
                      <div
                        key={w.id}
                        data-testid={`weight-row-other-${w.id}`}
                        title={`Switch to project '${projName}' to use this weight.`}
                        className={cn(
                          "w-full flex items-center gap-2 px-2 py-1.5 rounded-[var(--radius-xs)]",
                          "text-[12px] opacity-60 cursor-not-allowed",
                        )}
                      >
                        <span className="h-3.5 w-3.5" aria-hidden />
                        <span className="flex-1 min-w-0 truncate">
                          <span className="truncate">{w.name}</span>
                          <span className="ml-1 text-[10.5px] text-[color:var(--text-tertiary)]">
                            in project: {projName}
                          </span>
                        </span>
                        <span className="text-[10px] uppercase tracking-wider text-[color:var(--text-tertiary)]">
                          {w.task_kind}
                        </span>
                      </div>
                    );
                  })}
                  <p className="px-2 pb-1 text-[10.5px] text-[color:var(--text-tertiary)] italic">
                    Switch projects to use one of these weights.
                  </p>
                </div>
              )}
            </div>
          )}
          {weights.map((w) => (
            <button
              key={w.id}
              type="button"
              onClick={() => setSelected(w.id)}
              className={cn(
                "w-full flex items-center gap-2 px-2 py-1.5 rounded-[var(--radius-xs)]",
                "text-[12.5px] cursor-pointer outline-none",
                selected === w.id ? "bg-[var(--accent-bg)]" : "hover:bg-[var(--bg-hover)]",
              )}
              data-testid={`weight-row-${w.id}`}
              data-default={w.is_default ? "true" : undefined}
            >
              {selected === w.id ? (
                <Check className="h-3.5 w-3.5 text-[color:var(--accent)]" />
              ) : (
                <span className="h-3.5 w-3.5" aria-hidden />
              )}
              <span className="flex-1 truncate">{w.name}</span>
              {w.is_default && (
                <span
                  data-testid={`weight-default-badge-${w.id}`}
                  className="text-[9.5px] uppercase tracking-[0.10em] px-1.5 py-0.5 rounded bg-[var(--accent)] text-[color:var(--accent-fg)] font-medium"
                >
                  Default
                </span>
              )}
              <span className="text-[10px] uppercase tracking-wider text-[color:var(--text-tertiary)]">
                {w.task_kind}
              </span>
            </button>
          ))}
        </div>
        {/* v3.7 Phase 2 Issue 1 — predict scope picker. Defaults to
            "asset" (existing single-asset flow). Switching to "task"
            routes the predict through the RQ batch endpoint and opens
            the progress overlay. */}
        <div
          role="radiogroup"
          aria-label="Predict scope"
          data-testid="yolo-predict-scope"
          className="px-2 pt-2 pb-1 grid gap-1 border-t border-[var(--border-subtle)] mt-1"
        >
          <p className="px-1 pt-0.5 text-[10.5px] uppercase tracking-[0.10em] text-[color:var(--text-tertiary)]">
            Predict on
          </p>
          <label
            data-testid="yolo-predict-scope-asset"
            className={cn(
              "flex items-center gap-2 px-1.5 py-1 rounded-[var(--radius-xs)] cursor-pointer text-[12px]",
              scope === "asset"
                ? "bg-[var(--accent-bg)] text-[color:var(--text-primary)]"
                : "text-[color:var(--text-secondary)] hover:bg-[var(--bg-hover)]",
            )}
          >
            <input
              type="radio"
              name="yolo-predict-scope"
              value="asset"
              checked={scope === "asset"}
              onChange={() => setScope("asset")}
              className="accent-[var(--accent)]"
            />
            <span>Current asset</span>
          </label>
          <label
            data-testid="yolo-predict-scope-task"
            className={cn(
              "flex items-center gap-2 px-1.5 py-1 rounded-[var(--radius-xs)] cursor-pointer text-[12px]",
              scope === "task"
                ? "bg-[var(--accent-bg)] text-[color:var(--text-primary)]"
                : "text-[color:var(--text-secondary)] hover:bg-[var(--bg-hover)]",
            )}
          >
            <input
              type="radio"
              name="yolo-predict-scope"
              value="task"
              checked={scope === "task"}
              onChange={() => setScope("task")}
              className="accent-[var(--accent)]"
            />
            <span>All assets in task</span>
          </label>
        </div>
        {/* v3.5 Phase F3 — class overrides disclosure. Visible once a
            weight is selected and the task is known. Collapsed by default;
            shows "X of Y matched" so the user sees coverage at a glance. */}
        {selected && taskId && suggestions.length > 0 && (
          <div
            data-testid="yolo-class-overrides"
            className="px-2 pt-2 pb-1 grid gap-1.5 border-t border-[var(--border-subtle)] mt-1"
          >
            <button
              type="button"
              onClick={() => setOverridesExpanded((v) => !v)}
              data-testid="yolo-class-overrides-toggle"
              aria-expanded={overridesExpanded}
              className={cn(
                "w-full flex items-center justify-between gap-2 px-1 py-1",
                "text-[11.5px] tracking-tight",
                "text-[color:var(--text-secondary)] hover:text-[color:var(--text-primary)]",
              )}
            >
              <span className="flex items-center gap-1.5">
                <ChevronDown
                  className={cn(
                    "h-3 w-3 transition-transform",
                    overridesExpanded ? "rotate-180" : "rotate-0",
                  )}
                />
                Class mapping
              </span>
              <span
                data-testid="yolo-class-overrides-summary"
                className="font-mono tabular-nums text-[10.5px] text-[color:var(--text-tertiary)]"
              >
                {matchedCount} of {suggestions.length} matched
              </span>
            </button>
            {overridesExpanded && (
              <div className="grid gap-1.5 max-h-[180px] overflow-y-auto pr-1 pb-1">
                {suggestions.map((s) => {
                  const key = String(s.weight_class_idx);
                  const current = overrides[key];
                  const value =
                    current === null
                      ? OVERRIDE_SKIP
                      : (current ?? "");
                  return (
                    <label
                      key={key}
                      data-testid={`yolo-class-overrides-row-${s.weight_class_idx}`}
                      className="grid grid-cols-[80px_1fr] gap-1.5 items-center text-[11.5px]"
                    >
                      <span
                        className="font-mono text-[10.5px] text-[color:var(--text-tertiary)] truncate"
                        title={s.weight_class_name}
                      >
                        #{s.weight_class_idx} {s.weight_class_name}
                      </span>
                      <select
                        value={value}
                        onChange={(e) => {
                          const next = e.target.value;
                          setOverrides((prev) => ({
                            ...prev,
                            [key]:
                              next === OVERRIDE_SKIP
                                ? null
                                : next === ""
                                  ? null
                                  : next,
                          }));
                        }}
                        data-testid={`yolo-class-overrides-select-${s.weight_class_idx}`}
                        aria-label={`Project class for ${s.weight_class_name}`}
                        className={cn(
                          "h-7 px-2 rounded-[var(--radius-xs)]",
                          "border border-[var(--border-subtle)] bg-[var(--bg-elev)]",
                          "text-[11.5px] outline-none focus:border-[var(--accent)]",
                        )}
                      >
                        <option value={OVERRIDE_SKIP}>None / skip</option>
                        {s.alternatives.map((alt) => (
                          <option key={alt.id} value={alt.id}>
                            {alt.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  );
                })}
              </div>
            )}
          </div>
        )}
        <div className="px-2 pt-3 pb-2 grid gap-1.5 border-t border-[var(--border-subtle)] mt-1">
          <div className="flex items-center justify-between">
            <span className="text-[11.5px] text-[color:var(--text-secondary)] font-medium tracking-tight">
              Min confidence
            </span>
            <span
              data-testid="yolo-confidence-value"
              className="text-[11.5px] font-mono tabular-nums text-[color:var(--text-primary)]"
            >
              {(confidence * 100).toFixed(0)}%
            </span>
          </div>
          <input
            type="range"
            min={0}
            max={100}
            step={5}
            value={Math.round(confidence * 100)}
            onChange={(e) =>
              setConfidence(Math.max(0, Math.min(1, Number(e.target.value) / 100)))
            }
            data-testid="yolo-confidence-slider"
            aria-label="Minimum confidence"
            className="w-full accent-[var(--accent)]"
          />
          {/* v3.7.5 — IOU (NMS) threshold dial, identical styling to the
              confidence slider above. Range 0..1 step 0.05. Lower IOU =
              fewer overlapping boxes; higher IOU = more permissive NMS. */}
          <div className="flex items-center justify-between mt-2">
            <span className="text-[11.5px] text-[color:var(--text-secondary)] font-medium tracking-tight">
              IOU threshold
            </span>
            <span
              data-testid="yolo-iou-value"
              className="text-[11.5px] font-mono tabular-nums text-[color:var(--text-primary)]"
            >
              {(iou * 100).toFixed(0)}%
            </span>
          </div>
          <input
            type="range"
            min={0}
            max={100}
            step={5}
            value={Math.round(iou * 100)}
            onChange={(e) =>
              setIou(Math.max(0, Math.min(1, Number(e.target.value) / 100)))
            }
            data-testid="yolo-iou-slider"
            aria-label="IOU threshold"
            className="w-full accent-[var(--accent)]"
          />
        </div>
        <label className="flex items-center gap-2 px-2 py-2 text-[12px] text-[color:var(--text-secondary)]">
          <input
            type="checkbox"
            checked={overwrite}
            onChange={(e) => setOverwrite(e.target.checked)}
            className="h-3 w-3 accent-[var(--accent)]"
          />
          Overwrite existing annotations
        </label>
        {/* Plan-17 Phase 2 — opt-in SAM post-processing. Label is
            picked from the selected weight's task_kind:
              detect  → "Convert BBox to Polygon (SAM)"
              segment → "Refine with SAM after Predict"
            The checkbox is hidden for non-spatial weights (classify,
            pose) and for the batch scope ("All assets"). Single-asset
            only — for batch the user can marquee+right-click after. */}
        {samPostLabel && scope === "asset" && (
          <div className="grid gap-1.5 px-2 pb-2">
            <label className="flex items-center gap-2 text-[12px] text-[color:var(--text-secondary)]">
              <input
                type="checkbox"
                checked={samPost}
                onChange={(e) => setSamPost(e.target.checked)}
                data-testid="yolo-sam-post-toggle"
                className="h-3 w-3 accent-[var(--accent)]"
              />
              <span className="flex-1">
                {samPostLabel}
                <span className="ml-1 font-mono text-[10px] text-[color:var(--text-tertiary)]">
                  optional
                </span>
              </span>
            </label>
            {samPost && (
              <p className="ml-5 text-[10.5px] text-[color:var(--text-tertiary)]">
                Runs after predict on each new annotation. SAM auto-loads
                if not already mounted.
              </p>
            )}
            {samPostProgress && (
              <div
                data-testid="yolo-sam-post-progress"
                className="ml-5 mt-1 grid gap-1"
              >
                <div className="flex items-center justify-between text-[10.5px]">
                  <span className="text-[color:var(--text-secondary)]">
                    {selectedWeight?.task_kind === "detect"
                      ? "Converting with SAM…"
                      : "Refining with SAM…"}
                  </span>
                  <span className="font-mono tabular-nums text-[color:var(--text-tertiary)]">
                    {samPostProgress.done}/{samPostProgress.total}
                    {samPostProgress.failed > 0
                      ? ` · ${samPostProgress.failed} failed`
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
        )}
        {/* v3.7.2 — pre-flight warning banner when zero classes are
            mapped. Mirrors the user's data-loss scenario (yolov8n COCO
            classes vs. a 3-class custom project) and prevents the
            Predict button from firing a no-op that would have deleted
            existing annotations on the pre-fix code path. */}
        {noClassesMapped && (
          <div
            data-testid="yolo-no-mapping-warning"
            role="alert"
            className={cn(
              "mx-1 mb-2 px-2.5 py-2 rounded-[var(--radius-xs)]",
              "border border-[var(--warning)]/40 bg-[var(--warning)]/10",
              "text-[11.5px] text-[color:var(--warning-text,var(--text-primary))] leading-snug",
              "flex items-start gap-2",
            )}
          >
            <AlertTriangle
              className="h-3.5 w-3.5 mt-0.5 shrink-0 text-[color:var(--warning)]"
              aria-hidden
            />
            <span>
              <span className="font-medium">
                0 of {suggestions.length} weight classes
              </span>{" "}
              are mapped to your project's classes. Predict will skip all
              detections — no annotations will be created.
            </span>
          </div>
        )}
        <div className="flex items-center justify-end gap-1.5 pt-1">
          {(m.isError || batchM.isError) && (
            <span className="inline-flex items-center gap-1 text-[11px] text-[color:var(--danger)] mr-auto">
              <AlertTriangle className="h-3 w-3" /> Failed
            </span>
          )}
          {/* v3.7 Phase 2 Issue 2 — surface the keyboard shortcut so
              users learn the Cmd/Ctrl+Enter quick-predict path. Only
              renders the hint when no error is currently displayed so
              the failure indicator stays visible without crowding. */}
          {!m.isError && !batchM.isError && (
            <span
              data-testid="yolo-predict-shortcut-hint"
              className="text-[10.5px] text-[color:var(--text-tertiary)] mr-auto font-mono tabular-nums"
            >
              ⌘+Enter to predict
            </span>
          )}
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="h-7 px-2.5 rounded-[var(--radius-sm)] text-[12px] text-[color:var(--text-secondary)] hover:bg-[var(--bg-hover)]"
          >
            Cancel
          </button>
          <button
            type="button"
            // v3.7.2 — also disabled when zero classes are mapped, so
            // the user can't fire a predict that would skip everything.
            disabled={!selected || isPredicting || noClassesMapped}
            onClick={handlePredict}
            data-testid="yolo-predict-go"
            title={
              noClassesMapped
                ? "Map at least one class first"
                : undefined
            }
            className={cn(
              "inline-flex items-center gap-1.5 h-7 px-3 rounded-full",
              "bg-[var(--success)] text-white text-[12px] font-medium",
              "disabled:bg-[var(--bg-subtle)] disabled:text-[color:var(--text-tertiary)] disabled:cursor-not-allowed",
              "enabled:hover:bg-[var(--success-hover)]",
            )}
          >
            {isPredicting ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Sparkles className="h-3 w-3" />
            )}
            {isPredicting ? "Predicting…" : "Predict"}
          </button>
        </div>
      </PopoverContent>
      {/* v3.7 Phase 2 Issue 1 — RQ batch progress overlay. Polls
          ``GET /tasks/{taskId}/auto-annotate/{job_id}`` every 1.5s
          until the worker reaches a terminal state, then refetches
          annotations + asset queries so the new annotations appear. */}
      {batchJobId && taskId && (
        <BatchPredictProgressOverlay
          taskId={taskId}
          jobId={batchJobId}
          onClose={(progress) => {
            setBatchJobId(null);
            // Always refetch — even on partial success the user has new
            // annotations to see. We invalidate the same set the
            // single-asset path's onAfter would (annotations + assets).
            qc.invalidateQueries({ queryKey: ["annotations", taskId] });
            qc.invalidateQueries({ queryKey: ["task-annotations", taskId] });
            qc.invalidateQueries({ queryKey: ["task-assets", taskId] });
            onAfter?.();
            if (progress) {
              const total = progress.total;
              const done = progress.done;
              const failed = progress.failed;
              const successes = Math.max(0, done - failed);
              // v3.7.2 — surface aggregate created + skipped counts so
              // the user can tell a "completed but produced nothing"
              // batch (the original data-loss scenario, where 0 of 80
              // weight classes mapped) from a successful one.
              const created = progress.total_annotations_created ?? 0;
              const skipped = progress.total_skipped_detections ?? 0;
              // v3.7.4 — name the top unmapped classes so the user knows
              // *which* classes need mapping instead of just a count.
              const sbc = progress.skipped_by_class ?? {};
              const sortedSkipped = Object.entries(sbc)
                .filter(([, n]) => Number(n) > 0)
                .sort((a, b) => Number(b[1]) - Number(a[1]));
              const TOP_N = 5;
              const top = sortedSkipped.slice(0, TOP_N);
              const remainder = sortedSkipped.length - top.length;
              const topLabel = top
                .map(([name, count]) => `${name} (${count})`)
                .join(", ");
              const moreLabel =
                remainder > 0 ? ` + ${remainder} more` : "";
              // v3.7.4 — variant rules:
              //   - error    if any asset failed (or job-level "failed")
              //   - success  if created>0 AND skipped==0
              //   - warning  otherwise (created>0 + skipped>0, or created==0)
              const variant: "success" | "warning" | "error" =
                failed > 0 || progress.status === "failed"
                  ? "error"
                  : created > 0 && skipped === 0
                    ? "success"
                    : "warning";
              let skippedLine = "";
              if (skipped > 0 && top.length > 0) {
                skippedLine =
                  ` Skipped ${skipped} detections — top unmapped classes: ${topLabel}${moreLabel}.` +
                  ` Open Class mapping to add these.`;
              } else if (skipped > 0) {
                // No named breakdown — fall back to v3.7.2 wording.
                skippedLine = ` Skipped ${skipped} detections (unmapped classes).`;
              }
              const duration = top.length > 0 ? 8000 : 6000;
              showToast(
                `Created ${created} annotations across ${successes} of ${total} assets.${skippedLine}`,
                { variant, duration },
              );
            }
          }}
        />
      )}
    </Popover>
  );
});

/**
 * v3.7 Phase 2 Issue 1 — RQ batch predict progress overlay.
 *
 * Polls ``GET /tasks/{taskId}/auto-annotate/{job_id}`` every 1500ms
 * while ``open`` (i.e. ``jobId`` is non-null). Auto-dismisses when the
 * job reaches a terminal state ("completed" / "completed_with_errors"
 * / "failed") and fires ``onClose`` with the final progress snapshot
 * so the parent can toast the summary line.
 *
 * Cancel is best-effort UI: it simply unmounts the overlay. There is
 * no server-side cancel endpoint today (the worker keeps going until
 * the asset list is exhausted). Users can re-open the editor and the
 * new annotations show up regardless.
 */
function BatchPredictProgressOverlay({
  taskId,
  jobId,
  onClose,
}: {
  taskId: string;
  jobId: string;
  onClose: (final: BatchPredictProgress | null) => void;
}) {
  const POLL_INTERVAL_MS = 1500;
  const statusQ = useQuery<BatchPredictProgress>({
    queryKey: ["batch-predict-progress", taskId, jobId],
    queryFn: () => inferenceApi.pollBatchProgress(taskId, jobId),
    refetchInterval: (q) => {
      const s = q.state.data?.status;
      if (
        s === "completed" ||
        s === "completed_with_errors" ||
        s === "failed"
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

  // Auto-dismiss on terminal states.
  useEffect(() => {
    if (
      status === "completed" ||
      status === "completed_with_errors" ||
      status === "failed"
    ) {
      onClose(data ?? null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  const total = data?.total ?? 0;
  const done = data?.done ?? 0;
  const failed = data?.failed ?? 0;
  const hasRealProgress = total > 0;
  const pct = hasRealProgress
    ? Math.min(100, Math.round((done / total) * 100))
    : null;
  const subtitle = hasRealProgress
    ? `Predicting on ${done} of ${total} assets…`
    : "Predicting on assets…";

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="batch-predict-title"
      data-testid="batch-predict-overlay"
      className="fixed inset-0 z-[900] flex items-center justify-center"
    >
      <div
        aria-hidden
        className="absolute inset-0 bg-[rgba(15,23,42,0.32)]"
      />
      <div
        className={cn(
          "relative z-[901] w-[min(92vw,460px)]",
          "rounded-[var(--radius-lg)]",
          "glass-surface-strong glass-specular",
          "p-6 outline-none",
        )}
      >
        <button
          type="button"
          onClick={() => onClose(data ?? null)}
          aria-label="Close batch predict overlay"
          data-testid="batch-predict-close"
          className={cn(
            "absolute right-3 top-3 inline-flex h-7 w-7 items-center justify-center",
            "rounded-[var(--radius-sm)] text-[color:var(--text-tertiary)]",
            "hover:bg-[var(--bg-hover)] hover:text-[color:var(--text-primary)]",
          )}
        >
          <X className="h-4 w-4" />
        </button>

        <div className="grid gap-1 mb-4">
          <h2
            id="batch-predict-title"
            data-testid="batch-predict-title"
            className="text-[16px] font-medium tracking-tight text-[color:var(--text-primary)] flex items-center gap-2"
          >
            <Loader2 className="h-4 w-4 animate-spin text-[color:var(--accent)]" />
            Predicting on all assets
          </h2>
          <p
            data-testid="batch-predict-subtitle"
            className="text-[13px] text-[color:var(--text-secondary)]"
          >
            {subtitle}
          </p>
          {failed > 0 && (
            <p
              data-testid="batch-predict-failed-line"
              className="text-[11.5px] text-[color:var(--danger)]"
            >
              {failed} failed so far.
            </p>
          )}
        </div>

        <div
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct ?? undefined}
          aria-label={subtitle}
          data-testid={
            hasRealProgress
              ? "batch-predict-bar-determinate"
              : "batch-predict-bar-indeterminate"
          }
          className={cn(
            "relative h-1.5 w-full overflow-hidden rounded-full",
            "bg-[var(--bg-subtle)]",
          )}
        >
          {hasRealProgress ? (
            <div
              className="absolute inset-y-0 left-0 bg-[var(--accent)] transition-[width] duration-300 ease-out"
              style={{ width: `${pct}%` }}
            />
          ) : (
            <div className="absolute inset-y-0 -left-1/3 w-1/3 bg-[var(--accent)] animate-[modelLoadingShimmer_1.4s_ease-in-out_infinite]" />
          )}
        </div>

        <p className="mt-3 text-[11.5px] text-[color:var(--text-tertiary)] leading-snug">
          The model is running auto-annotate over every asset in the
          task. You can keep working — the new annotations will appear
          on each asset once they are ready.
        </p>

        <div className="mt-6 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={() => onClose(null)}
            data-testid="batch-predict-cancel"
            className={cn(
              "h-8 px-3 rounded-[var(--radius-sm)] text-[12.5px]",
              "text-[color:var(--text-secondary)] hover:bg-[var(--bg-hover)]",
            )}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

function VisibilityDropdown() {
  const visibility = useTool((s) => s.visibility);
  const setVisibility = useTool((s) => s.setVisibility);

  const items: { key: keyof VisibilityFlags; label: string }[] = [
    { key: "annotations", label: "Annotations" },
    { key: "labels", label: "Class labels" },
    { key: "pixels", label: "Pixels (mask overlay)" },
    { key: "crosshairs", label: "Crosshairs" },
    { key: "thumbnails", label: "Nav thumbnails" },
  ];

  const allOn = items.every((i) => visibility[i.key]);

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          data-testid="visibility-trigger"
          aria-label="Visibility menu"
          title="Visibility"
          className={cn(
            "grid h-8 w-8 place-items-center rounded-[var(--radius-sm)] transition-colors",
            allOn
              ? "text-[color:var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[color:var(--text-primary)]"
              : "bg-[var(--bg-hover)] text-[color:var(--text-tertiary)]",
          )}
        >
          <Eye className="h-[18px] w-[18px]" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={6}
          className="z-[1000] min-w-[220px] rounded-[var(--radius-md)] glass-surface-strong p-1"
        >
          {items.map((i) => (
            <DropdownMenu.CheckboxItem
              key={i.key}
              checked={visibility[i.key]}
              onCheckedChange={(v) => setVisibility(i.key, !!v)}
              onSelect={(e) => e.preventDefault()}
              data-testid={`vis-${i.key}`}
              className="flex items-center gap-2 px-2 py-1.5 rounded-[var(--radius-xs)] text-[12.5px] cursor-pointer outline-none hover:bg-[var(--bg-hover)] data-[highlighted]:bg-[var(--bg-hover)]"
            >
              <span
                className={cn(
                  "grid h-3.5 w-3.5 place-items-center rounded-[3px] border",
                  visibility[i.key]
                    ? "bg-[var(--accent)] border-[var(--accent)] text-white"
                    : "border-[var(--border-strong)]",
                )}
              >
                {visibility[i.key] && <Check className="h-2.5 w-2.5" />}
              </span>
              <span>{i.label}</span>
            </DropdownMenu.CheckboxItem>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function MaskBrushSizeControl() {
  const active = useTool((s) => s.active);
  const radius = useTool((s) => s.maskBrushRadius);
  const setRadius = useTool((s) => s.setMaskBrushRadius);
  if (active !== "mask") return null;
  // Plan-15 Phase 9 follow-up — shrunk to fit the main toolbar row in
  // brush mode (preset chips moved into the popover below; the slider
  // alone is enough for in-row tweaks).
  return (
    <div
      className="inline-flex items-center gap-1.5 h-8 px-2 rounded-[var(--radius-sm)] bg-[var(--bg-subtle)]"
      data-testid="mask-brush-size-control"
      title={`Brush size — ${radius}px`}
    >
      <Brush aria-hidden className="h-3.5 w-3.5 text-[color:var(--text-tertiary)]" />
      <input
        type="range"
        min={1}
        max={100}
        step={1}
        value={Math.min(100, Math.max(1, radius))}
        onChange={(e) => setRadius(Number(e.target.value))}
        aria-label="Brush radius"
        data-testid="mask-brush-size-slider"
        className="w-16 accent-[var(--accent)]"
      />
      <span
        className="font-mono tabular-nums text-[11px] text-[color:var(--text-primary)] w-7 text-right"
        data-testid="mask-brush-size-value"
      >
        {radius}
      </span>
    </div>
  );
}

/**
 * Plan 09 Task 11 — Mask brush hardness slider. Shown only when the
 * mask tool is active, sits directly alongside the brush-size control.
 * Hardness 0..1 with 0.05 step; default 0.7. Controls the alpha
 * falloff curve in `MaskRasterizer.paintBrushHardness`.
 */
function MaskBrushHardnessControl() {
  const active = useTool((s) => s.active);
  const hardness = useTool((s) => s.maskHardness);
  const setHardness = useTool((s) => s.setMaskHardness);
  if (active !== "mask") return null;
  return (
    <div
      className="inline-flex items-center gap-1.5 h-8 px-2 rounded-[var(--radius-sm)] bg-[var(--bg-subtle)]"
      data-testid="mask-brush-hardness-control"
      title={`Brush hardness — ${Math.round(hardness * 100)}%`}
    >
      <span className="text-[10px] tracking-tight text-[color:var(--text-tertiary)]">
        Hard
      </span>
      <input
        type="range"
        min={0}
        max={1}
        step={0.05}
        value={Math.max(0, Math.min(1, hardness))}
        onChange={(e) => setHardness(Number(e.target.value))}
        aria-label="Brush hardness"
        data-testid="mask-brush-hardness-slider"
        className="w-16 accent-[var(--accent)]"
      />
      <span
        className="font-mono tabular-nums text-[11px] text-[color:var(--text-primary)] w-8 text-right"
        data-testid="mask-brush-hardness-value"
      >
        {Math.round(hardness * 100)}%
      </span>
    </div>
  );
}

/**
 * Plan 09 Task 11 — Eraser toggle button. When pressed, left-click in
 * the mask tool subtracts from the mask. Right-click is always erase
 * regardless of this toggle.
 */
function MaskBrushEraserToggle() {
  const active = useTool((s) => s.active);
  const eraser = useTool((s) => s.maskEraser);
  const toggle = useTool((s) => s.toggleMaskEraser);
  if (active !== "mask") return null;
  return (
    <button
      type="button"
      onClick={toggle}
      aria-label="Toggle eraser"
      aria-pressed={eraser}
      data-testid="mask-brush-eraser-toggle"
      data-active={eraser ? "true" : "false"}
      title={eraser ? "Eraser on (click to disable)" : "Eraser off (click to enable)"}
      className={cn(
        "inline-flex items-center justify-center h-8 w-8 rounded-[var(--radius-sm)]",
        "transition-colors",
        eraser
          ? "bg-[var(--accent)] text-[color:var(--accent-fg)]"
          : "bg-[var(--bg-subtle)] text-[color:var(--text-secondary)] hover:bg-[var(--bg-hover)]",
      )}
    >
      <Eraser className="h-[16px] w-[16px]" />
    </button>
  );
}

/**
 * v3.5 Phase D/E — SAM mode picker. Inline 4-chip strip (Point / Box /
 * Text / Track) shown only while the SAM tool is active.
 *
 *   - Point — both SAM 2 and SAM 3.
 *   - Box / Text — SAM 3 only; on SAM 2 variants those chips render
 *     disabled with a tooltip directing the user to the SAM picker.
 *   - Track — both SAM 2 and SAM 3, but only when the active asset is
 *     a multi-frame video (gated by ``isVideo``). Switches the right
 *     rail to the dedicated <SamTrackPanel>.
 *
 * The picker writes into the ``samMode`` field of the tool store; the
 * canvas + SamTool subscribe and reset their in-flight state on
 * transitions.
 */
function SamModePicker({ isVideo }: { isVideo: boolean }) {
  const active = useTool((s) => s.active);
  const samMode = useTool((s) => s.samMode);
  const setSamMode = useTool((s) => s.setSamMode);
  const samQ = useQuery({
    queryKey: ["sam-active"],
    queryFn: () => modelsApi.samActive(),
  });
  const variant = samQ.data?.active ?? "sam2.1-base+";
  // Anything starting with "sam3" gates text + box prompting on. The
  // model-service API has the canonical check (get_sam_variant()), but
  // gating on the variant string in the UI prevents a guaranteed-409
  // round-trip for SAM 2 users.
  const isSam3 = variant.toLowerCase().startsWith("sam3");

  if (active !== "sam") return null;

  const modes: {
    id: import("@/canvas/tools/SamTool").SamMode;
    label: string;
    sam3Only: boolean;
    videoOnly: boolean;
  }[] = [
    { id: "point", label: "Point", sam3Only: false, videoOnly: false },
    // v3.8 Phase 2 — Box mode now goes through /sam/encode + /sam/decode
    // (with optional `box` arg) so it works on both SAM 2 and SAM 3.
    { id: "box", label: "Box", sam3Only: false, videoOnly: false },
    { id: "text", label: "Text", sam3Only: true, videoOnly: false },
    { id: "track", label: "Track", sam3Only: false, videoOnly: true },
  ];

  return (
    <div
      role="radiogroup"
      aria-label="SAM input mode"
      data-testid="sam-mode-picker"
      className="inline-flex items-center gap-0.5 h-8 px-1 rounded-[var(--radius-sm)] bg-[var(--bg-subtle)]"
    >
      {modes.map((m) => {
        const sam3Disabled = m.sam3Only && !isSam3;
        const videoDisabled = m.videoOnly && !isVideo;
        const disabled = sam3Disabled || videoDisabled;
        const isActive = samMode === m.id;
        const tooltipText = videoDisabled
          ? "Open a video asset to enable tracking"
          : "Switch to SAM 3 for text/box prompting";
        const button = (
          <button
            key={m.id}
            type="button"
            role="radio"
            aria-checked={isActive}
            aria-disabled={disabled}
            disabled={disabled}
            onClick={() => {
              if (disabled) return;
              setSamMode(m.id);
            }}
            data-testid={`sam-mode-${m.id}`}
            data-active={isActive ? "true" : undefined}
            data-disabled={disabled ? "true" : undefined}
            className={cn(
              "h-6 px-2 rounded-[var(--radius-xs)] text-[11.5px] font-medium tracking-tight transition-colors",
              isActive
                ? "bg-[var(--accent)] text-[color:var(--accent-fg)]"
                : "text-[color:var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[color:var(--text-primary)]",
              disabled && "opacity-40 cursor-not-allowed hover:bg-transparent",
            )}
          >
            {m.label}
          </button>
        );
        if (disabled) {
          return (
            <Tooltip key={m.id} content={tooltipText}>
              {button}
            </Tooltip>
          );
        }
        return button;
      })}
    </div>
  );
}

function AutoApplyToggle() {
  const active = useTool((s) => s.active);
  const auto = useTool((s) => s.autoApply);
  const setAuto = useTool((s) => s.setAutoApply);
  if (active !== "sam") return null;
  return (
    <Tooltip
      content={
        <span className="flex flex-col items-start gap-0.5 max-w-[220px]">
          <span className="flex items-center gap-1.5">
            Auto-apply SAM mask
            <Kbd className="bg-white/10 text-white border-white/20">A</Kbd>
          </span>
          <span className="text-[10.5px] opacity-70">
            When on, a SAM proposal commits as soon as it is generated — no Enter required.
          </span>
        </span>
      }
    >
      <button
        type="button"
        data-testid="auto-apply-toggle"
        aria-label="Toggle SAM auto-apply"
        aria-pressed={auto}
        onClick={() => setAuto(!auto)}
        className={cn(
          "grid h-8 w-8 place-items-center rounded-[var(--radius-sm)] transition-colors border",
          auto
            ? "bg-[var(--success-bg)] border-[var(--success)] text-[var(--success)]"
            : "border-transparent text-[color:var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[color:var(--text-primary)]",
        )}
      >
        <Wand2 className="h-[18px] w-[18px]" />
      </button>
    </Tooltip>
  );
}

/**
 * Zoom % display + presets popover. Clicking the % toggles into an
 * inline numeric input — typing a number and pressing Enter sets the
 * canvas zoom to that exact percentage. v2.6 zoom — replaces the
 * previous read-only popover.
 */
function ZoomPercent({
  zoomPct,
  onZoomTo,
}: {
  zoomPct: number;
  onZoomTo?: (p: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(String(Math.round(zoomPct)));
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Keep the draft in sync with the live zoom when not editing — so
  // returning to display mode shows the current value rather than the
  // last entered draft.
  useEffect(() => {
    if (!editing) setDraft(String(Math.round(zoomPct)));
  }, [zoomPct, editing]);

  function commit(): void {
    const n = Number(draft);
    if (Number.isFinite(n) && n > 0) {
      // Clamp to the canvas' allowed range (mirrors zoom.MIN_SCALE /
      // MAX_SCALE — kept here as raw numbers so the toolbar doesn't
      // need to import the canvas helpers).
      const clamped = Math.max(10, Math.min(1000, n));
      onZoomTo?.(clamped);
    }
    setEditing(false);
  }

  if (editing) {
    return (
      <input
        ref={(el) => {
          inputRef.current = el;
          if (el) {
            // Auto-focus + select on enter so the user can type directly.
            requestAnimationFrame(() => {
              try {
                el.focus();
                el.select();
              } catch {
                /* ignore focus errors */
              }
            });
          }
        }}
        type="number"
        min={10}
        max={1000}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          else if (e.key === "Escape") {
            setDraft(String(Math.round(zoomPct)));
            setEditing(false);
          }
        }}
        data-testid="zoom-percent-input"
        aria-label="Zoom percentage"
        className={cn(
          "h-8 w-16 px-1 rounded-[var(--radius-sm)] font-mono text-[11.5px] tabular-nums text-center",
          "bg-[var(--bg-subtle)] text-[color:var(--text-primary)]",
          "outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent)]",
        )}
      />
    );
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="zoom-percent"
          aria-label="Zoom level"
          title="Zoom level — click to enter exact %"
          onDoubleClick={() => setEditing(true)}
          className="h-8 px-2 rounded-[var(--radius-sm)] font-mono text-[11.5px] text-[color:var(--text-secondary)] tabular-nums hover:bg-[var(--bg-hover)] hover:text-[color:var(--text-primary)]"
        >
          {Math.round(zoomPct)}%
        </button>
      </PopoverTrigger>
      <PopoverContent align="center" className="min-w-[180px] p-1">
        <button
          type="button"
          onClick={() => setEditing(true)}
          data-testid="zoom-enter-exact"
          className="w-full text-left px-2 py-1.5 rounded-[var(--radius-xs)] text-[12.5px] hover:bg-[var(--bg-hover)]"
        >
          Enter exact %…
        </button>
        <div className="my-1 h-px bg-[var(--border-subtle)]" aria-hidden />
        {[25, 50, 100, 200, 400].map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => onZoomTo?.(p)}
            className="w-full text-left px-2 py-1.5 rounded-[var(--radius-xs)] text-[12.5px] hover:bg-[var(--bg-hover)]"
          >
            {p}%
          </button>
        ))}
        <button
          type="button"
          onClick={() => onZoomTo?.(0)}
          className="w-full text-left px-2 py-1.5 rounded-[var(--radius-xs)] text-[12.5px] hover:bg-[var(--bg-hover)]"
        >
          Fit
        </button>
      </PopoverContent>
    </Popover>
  );
}

function ZoomControls({
  zoomPct,
  onZoomIn,
  onZoomOut,
  onZoomTo,
  onZoomActual,
}: {
  zoomPct?: number;
  onZoomIn?: () => void;
  onZoomOut?: () => void;
  onZoomTo?: (p: number) => void;
  onZoomActual?: () => void;
}) {
  const z = zoomPct ?? 100;
  return (
    <div className="flex items-center gap-0.5" data-testid="zoom-controls">
      <Tooltip content="Zoom out (−)">
        <button
          type="button"
          onClick={onZoomOut}
          aria-label="Zoom out"
          data-testid="zoom-out"
          className="grid h-8 w-7 place-items-center rounded-[var(--radius-sm)] text-[color:var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[color:var(--text-primary)]"
        >
          <Minus className="h-3.5 w-3.5" />
        </button>
      </Tooltip>
      <ZoomPercent zoomPct={z} onZoomTo={onZoomTo} />
      <Tooltip content="Zoom in (+)">
        <button
          type="button"
          onClick={onZoomIn}
          aria-label="Zoom in"
          data-testid="zoom-in"
          className="grid h-8 w-7 place-items-center rounded-[var(--radius-sm)] text-[color:var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[color:var(--text-primary)]"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </Tooltip>
      <Tooltip
        content={
          <span className="flex items-center gap-1.5">
            Actual size
            <Kbd className="bg-white/10 text-white border-white/20">1</Kbd>
          </span>
        }
      >
        <button
          type="button"
          onClick={onZoomActual}
          aria-label="Zoom to 1:1"
          data-testid="zoom-actual"
          className="h-8 px-1.5 rounded-[var(--radius-sm)] font-mono text-[10.5px] tabular-nums text-[color:var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[color:var(--text-primary)]"
        >
          1:1
        </button>
      </Tooltip>
    </div>
  );
}

function UndoRedoControls({ onUndo, onRedo }: { onUndo?: () => void; onRedo?: () => void }) {
  const past = useAnnotations((s) => s.history.past);
  const future = useAnnotations((s) => s.history.future);
  const canUndo = past.length > 0;
  const canRedo = future.length > 0;
  return (
    <div className="flex items-center">
      <Tooltip
        content={
          <span className="flex items-center gap-1.5">
            Undo
            <Kbd className="bg-white/10 text-white border-white/20">⌘Z</Kbd>
          </span>
        }
      >
        <button
          type="button"
          onClick={onUndo}
          disabled={!canUndo}
          data-testid="undo-button"
          aria-label="Undo"
          className={cn(
            "grid h-8 w-8 place-items-center rounded-[var(--radius-sm)] transition-colors",
            "text-[color:var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[color:var(--text-primary)]",
            "disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent",
          )}
        >
          <Undo2 className="h-[16px] w-[16px]" />
        </button>
      </Tooltip>
      <Tooltip
        content={
          <span className="flex items-center gap-1.5">
            Redo
            <Kbd className="bg-white/10 text-white border-white/20">⌘⇧Z</Kbd>
          </span>
        }
      >
        <button
          type="button"
          onClick={onRedo}
          disabled={!canRedo}
          data-testid="redo-button"
          aria-label="Redo"
          className={cn(
            "grid h-8 w-8 place-items-center rounded-[var(--radius-sm)] transition-colors",
            "text-[color:var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[color:var(--text-primary)]",
            "disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent",
          )}
        >
          <Redo2 className="h-[16px] w-[16px]" />
        </button>
      </Tooltip>
    </div>
  );
}

/**
 * Editor toolbar — 40px horizontal strip under TopBar. Left: undo/redo + tool icons.
 * Center: SAM picker, auto-apply, visibility, fit. Right: zoom %, save indicator,
 * YOLO predict, Save button.
 */
export function EditorToolbar({
  onSave,
  isSaving,
  hasError,
  dirtyCount,
  onFitToScreen,
  onZoomIn,
  onZoomOut,
  onZoomTo,
  onZoomActual,
  onUndo,
  onRedo,
  zoomPct,
  projectId,
  taskId,
  assetId,
  isVideo = false,
  onAfterYoloPredict,
  classes: classesProp,
  rightSlot,
}: EditorToolbarProps) {
  const active = useTool((s) => s.active);
  const setActive = useTool((s) => s.setActive);
  const toggleAutoApply = useTool((s) => s.toggleAutoApply);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [filterDialogOpen, setFilterDialogOpen] = useState(false);
  // Drive the Filter icon's "active" styling from the filter store so
  // users can see at a glance whether a filter is currently applied
  // even when the dialog is closed.
  const filterActive = useFilter((s) => hasMeaningfulRules(s.filter));

  // v3.7 Phase 2 Issue 2 — imperative handle to the YOLO predict
  // button so the global Cmd/Ctrl+Enter shortcut can fire a quick
  // predict (or fall back to opening the popover) without owning the
  // weight/overrides/scope state itself.
  const predictRef = useRef<YoloPredictHandle | null>(null);

  // Plan 14 Phase 8 Task 9 — collapse less-used toolbar items into a
  // `…` overflow DropdownMenu below 1280px. Inline matchMedia in a
  // useEffect (the codebase has no shared `useMediaQuery` hook yet).
  const [isNarrow, setIsNarrow] = useState<boolean>(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return false;
    }
    return window.matchMedia("(max-width: 1279px)").matches;
  });
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }
    const mql = window.matchMedia("(max-width: 1279px)");
    const update = () => setIsNarrow(mql.matches);
    update();
    // Use addEventListener for modern browsers; fall back to addListener
    // for older Safari / jsdom polyfills that may not implement the
    // newer API surface.
    if (typeof mql.addEventListener === "function") {
      mql.addEventListener("change", update);
      return () => mql.removeEventListener("change", update);
    }
    type LegacyMql = MediaQueryList & {
      addListener: (listener: (e: MediaQueryListEvent) => void) => void;
      removeListener: (listener: (e: MediaQueryListEvent) => void) => void;
    };
    const legacy = mql as LegacyMql;
    legacy.addListener(update);
    return () => legacy.removeListener(update);
  }, []);

  // Single-letter hotkeys (V/B/P/M/T/S/A/F) trigger tool selection,
  // plus zoom-related keys: + / - / 0 / 1 / Cmd|Ctrl + + / -. v2.6 zoom.
  // v3.7 Phase 2 Issue 2 — Cmd/Ctrl+Enter fires the YOLO quick predict.
  useEffect(() => {
    function handler(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      // Cmd / Ctrl + (+ / -) — match the browser default keys but route
      // them through the canvas instead of letting the page zoom. The
      // user expects ⌘+ to zoom the image, not the whole tab.
      if ((e.metaKey || e.ctrlKey) && !e.altKey) {
        // v3.7 Phase 2 Issue 2 — Cmd/Ctrl+Enter quick predict. ``P``
        // would collide with the Polygon tool, so we use Enter (which
        // is otherwise unbound at the editor level) instead.
        if (e.key === "Enter") {
          e.preventDefault();
          predictRef.current?.quickPredict();
          return;
        }
        if (e.key === "+" || e.key === "=") {
          e.preventDefault();
          onZoomIn?.();
          return;
        }
        if (e.key === "-" || e.key === "_") {
          e.preventDefault();
          onZoomOut?.();
          return;
        }
        if (e.key === "0") {
          e.preventDefault();
          onFitToScreen?.();
          return;
        }
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      // Bare zoom shortcuts. Use `e.key` directly (not toLowerCase) so
      // shifted keys like `+` and `_` still match.
      if (e.key === "+" || e.key === "=") {
        onZoomIn?.();
        return;
      }
      if (e.key === "-" || e.key === "_") {
        onZoomOut?.();
        return;
      }
      if (e.key === "0") {
        onFitToScreen?.();
        return;
      }
      if (e.key === "1") {
        onZoomActual?.();
        return;
      }
      const k = e.key.toLowerCase();
      if (k === "a") {
        toggleAutoApply();
        return;
      }
      if (k === "f") {
        onFitToScreen?.();
        return;
      }
      const match = TOOLS.find((tool) => tool.hotkey.toLowerCase() === k);
      if (match) {
        setActive(match.name);
      }
    }
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [
    setActive,
    toggleAutoApply,
    onFitToScreen,
    onZoomIn,
    onZoomOut,
    onZoomActual,
  ]);

  return (
    <div
      role="toolbar"
      aria-label="Annotation tools"
      data-testid="editor-toolbar"
      className={cn(
        "relative h-11 shrink-0 mx-2 mt-2 flex items-center gap-1 px-2.5 rounded-2xl",
        "glass-surface-strong glass-specular",
        // Plan 14 Phase 8 Task 9 — keep the toolbar pinned at the top of
        // the canvas region during scroll. ``z-20`` keeps it above the
        // canvas overlays (z-10) but below modal/dialog surfaces (z-50+).
        "sticky top-0 z-20",
      )}
    >
      <UndoRedoControls onUndo={onUndo} onRedo={onRedo} />

      <span aria-hidden className="mx-1 h-5 w-px bg-[var(--glass-border-strong)]" />

      {TOOLS.map((t) => (
        <ToolButton
          key={t.name}
          active={active === t.name}
          label={t.label}
          hotkey={t.hotkey}
          onClick={() => setActive(t.name)}
        >
          {t.icon}
        </ToolButton>
      ))}

      <span aria-hidden className="mx-1 h-5 w-px bg-[var(--glass-border-strong)]" />

      <SamModelPicker />
      <SamModePicker isVideo={isVideo} />
      <AutoApplyToggle />
      <MaskBrushSizeControl />
      <MaskBrushHardnessControl />
      <MaskBrushEraserToggle />

      <span aria-hidden className="mx-1 h-5 w-px bg-[var(--glass-border-strong)]" />

      {/*
        Plan 14 Phase 8 Task 9 — at >=1280px we render visibility +
        fit-to-screen inline; below that they collapse into the trailing
        overflow menu (see further down). Tool selector, zoom, save and
        the SAM/auto-annotate widgets remain visible in both layouts.
      */}
      {!isNarrow && (
        <>
          <VisibilityDropdown />

          <Tooltip
            content={
              <span className="flex items-center gap-1.5">
                Fit to screen
                <Kbd className="bg-white/10 text-white border-white/20">F</Kbd>
              </span>
            }
          >
            <button
              type="button"
              onClick={onFitToScreen}
              aria-label="Fit to screen"
              className="grid h-8 w-8 place-items-center rounded-[var(--radius-sm)] text-[color:var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[color:var(--text-primary)] transition-colors"
            >
              <Maximize className="h-[18px] w-[18px]" />
            </button>
          </Tooltip>
        </>
      )}

      <div className="flex-1" />

      <ZoomControls
        zoomPct={zoomPct}
        onZoomIn={onZoomIn}
        onZoomOut={onZoomOut}
        onZoomTo={onZoomTo}
        onZoomActual={onZoomActual}
      />

      <span aria-hidden className="mx-1 h-5 w-px bg-[var(--glass-border-strong)]" />

      <SaveIndicator
        isSaving={isSaving}
        hasError={hasError}
        dirtyCount={dirtyCount}
        onRetry={onSave}
      />

      <YoloPredictButton
        ref={predictRef}
        projectId={projectId}
        taskId={taskId}
        assetId={assetId}
        onAfter={onAfterYoloPredict}
      />

      {/* v3.8 Phase 3.5 — Auto-annotate (SAM 3 text). Lives next to the
          YOLO predict button so users have one consistent place for
          "let the model help me". */}
      <AutoAnnotateDialog
        assetId={assetId ?? null}
        taskId={taskId}
        classes={classesProp ?? []}
        onSuccess={onAfterYoloPredict}
      />

      {/* v3.8 Phase 4-video step F5 — Re-extract removed per request:
          the upload-time dialog is the single point of frame-strategy
          choice; the original video is deleted after extraction so a
          re-extract isn't possible anyway. */}

      {!isNarrow && (
        <Tooltip content={filterActive ? "Filter (active)" : "Filter annotations"}>
          <button
            type="button"
            onClick={() => setFilterDialogOpen(true)}
            aria-label="Filter annotations"
            aria-pressed={filterActive}
            data-testid="filter-trigger"
            className={cn(
              "grid h-8 w-8 place-items-center rounded-[var(--radius-sm)] transition-colors",
              filterActive
                ? "text-[color:var(--accent)] bg-[var(--accent-bg)] hover:bg-[var(--bg-hover)]"
                : "text-[color:var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[color:var(--text-primary)]",
            )}
          >
            <Filter className="h-[16px] w-[16px]" />
          </button>
        </Tooltip>
      )}
      <FilterBuilderDialog
        open={filterDialogOpen}
        onOpenChange={setFilterDialogOpen}
      />

      {!isNarrow && (
        <>
          <Tooltip content="Keyboard shortcuts">
            <button
              type="button"
              onClick={() =>
                window.dispatchEvent(new CustomEvent("carve:open-cheat-sheet"))
              }
              aria-label="Keyboard shortcuts"
              data-testid="editor-cheatsheet-trigger"
              className="grid h-8 w-8 place-items-center rounded-[var(--radius-sm)] text-[color:var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[color:var(--text-primary)] transition-colors"
            >
              <Keyboard className="h-[16px] w-[16px]" />
            </button>
          </Tooltip>
          <Tooltip content="Task info">
            <button
              type="button"
              onClick={() =>
                window.dispatchEvent(new CustomEvent("carve:open-info-dialog"))
              }
              aria-label="Task info"
              data-testid="editor-info-trigger"
              className="grid h-8 w-8 place-items-center rounded-[var(--radius-sm)] text-[color:var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[color:var(--text-primary)] transition-colors"
            >
              <Info className="h-[16px] w-[16px]" />
            </button>
          </Tooltip>
          {rightSlot}
          <Tooltip content="Editor settings">
            <button
              type="button"
              onClick={() => setSettingsOpen(true)}
              aria-label="Editor settings"
              data-testid="editor-settings-trigger"
              className="grid h-8 w-8 place-items-center rounded-[var(--radius-sm)] text-[color:var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[color:var(--text-primary)] transition-colors"
            >
              <Settings className="h-[16px] w-[16px]" />
            </button>
          </Tooltip>
        </>
      )}
      <EditorSettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />

      {/*
        Plan 14 Phase 8 Task 9 — overflow menu at <1280px. Surfaces the
        items that were elided from the inline toolbar (visibility,
        fit-to-screen, filter, editor settings) plus the editor's
        cheat-sheet / command palette / info dialog triggers, which live
        on the canvas at wider widths.
      */}
      {isNarrow && (
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button
              type="button"
              data-testid="editor-toolbar-overflow-trigger"
              aria-label="More toolbar actions"
              className="grid h-8 w-8 place-items-center rounded-[var(--radius-sm)] text-[color:var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[color:var(--text-primary)] transition-colors"
            >
              <MoreHorizontal className="h-[18px] w-[18px]" />
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              align="end"
              sideOffset={6}
              data-testid="editor-toolbar-overflow-content"
              className="z-[1000] min-w-[220px] rounded-[var(--radius-md)] glass-surface-strong p-1"
            >
              <DropdownMenu.Item
                data-testid="overflow-fit-to-screen"
                onSelect={(e) => {
                  e.preventDefault();
                  onFitToScreen?.();
                }}
                className="flex items-center gap-2 px-2 py-1.5 rounded-[var(--radius-xs)] text-[12.5px] cursor-pointer outline-none hover:bg-[var(--bg-hover)] data-[highlighted]:bg-[var(--bg-hover)]"
              >
                <Maximize className="h-3.5 w-3.5" />
                <span>Fit to screen</span>
              </DropdownMenu.Item>
              <DropdownMenu.Item
                data-testid="overflow-visibility"
                onSelect={(e) => {
                  e.preventDefault();
                  window.dispatchEvent(new CustomEvent("carve:open-visibility"));
                }}
                className="flex items-center gap-2 px-2 py-1.5 rounded-[var(--radius-xs)] text-[12.5px] cursor-pointer outline-none hover:bg-[var(--bg-hover)] data-[highlighted]:bg-[var(--bg-hover)]"
              >
                <Eye className="h-3.5 w-3.5" />
                <span>Visibility…</span>
              </DropdownMenu.Item>
              <DropdownMenu.Item
                data-testid="overflow-filter"
                onSelect={(e) => {
                  e.preventDefault();
                  setFilterDialogOpen(true);
                }}
                className="flex items-center gap-2 px-2 py-1.5 rounded-[var(--radius-xs)] text-[12.5px] cursor-pointer outline-none hover:bg-[var(--bg-hover)] data-[highlighted]:bg-[var(--bg-hover)]"
              >
                <Filter className="h-3.5 w-3.5" />
                <span>Filter annotations</span>
              </DropdownMenu.Item>
              <DropdownMenu.Item
                data-testid="overflow-cheatsheet"
                onSelect={(e) => {
                  e.preventDefault();
                  window.dispatchEvent(new CustomEvent("carve:open-cheatsheet"));
                }}
                className="flex items-center gap-2 px-2 py-1.5 rounded-[var(--radius-xs)] text-[12.5px] cursor-pointer outline-none hover:bg-[var(--bg-hover)] data-[highlighted]:bg-[var(--bg-hover)]"
              >
                <span className="font-mono text-[10px]">⌨</span>
                <span>Keyboard shortcuts</span>
              </DropdownMenu.Item>
              <DropdownMenu.Item
                data-testid="overflow-command-palette"
                onSelect={(e) => {
                  e.preventDefault();
                  window.dispatchEvent(new CustomEvent("carve:open-command-palette"));
                }}
                className="flex items-center gap-2 px-2 py-1.5 rounded-[var(--radius-xs)] text-[12.5px] cursor-pointer outline-none hover:bg-[var(--bg-hover)] data-[highlighted]:bg-[var(--bg-hover)]"
              >
                <Sparkles className="h-3.5 w-3.5" />
                <span>Command palette</span>
              </DropdownMenu.Item>
              <DropdownMenu.Item
                data-testid="overflow-info"
                onSelect={(e) => {
                  e.preventDefault();
                  window.dispatchEvent(new CustomEvent("carve:open-info-dialog"));
                }}
                className="flex items-center gap-2 px-2 py-1.5 rounded-[var(--radius-xs)] text-[12.5px] cursor-pointer outline-none hover:bg-[var(--bg-hover)] data-[highlighted]:bg-[var(--bg-hover)]"
              >
                <span className="font-mono text-[10px]">i</span>
                <span>Task info</span>
              </DropdownMenu.Item>
              <DropdownMenu.Separator className="my-1 h-px bg-[var(--border-subtle)]" />
              <DropdownMenu.Item
                data-testid="overflow-settings"
                onSelect={(e) => {
                  e.preventDefault();
                  setSettingsOpen(true);
                }}
                className="flex items-center gap-2 px-2 py-1.5 rounded-[var(--radius-xs)] text-[12.5px] cursor-pointer outline-none hover:bg-[var(--bg-hover)] data-[highlighted]:bg-[var(--bg-hover)]"
              >
                <Settings className="h-3.5 w-3.5" />
                <span>Editor settings</span>
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      )}

      <Tooltip
        content={
          <span className="flex items-center gap-1.5">
            Save now
            <Kbd className="bg-white/10 text-white border-white/20">⌘ S</Kbd>
          </span>
        }
      >
        <button
          type="button"
          onClick={onSave}
          aria-label="Save now"
          aria-disabled={dirtyCount === 0 && !isSaving && !hasError}
          className={cn(
            "ml-1 inline-flex h-8 items-center gap-1.5 px-3 rounded-full",
            "bg-[var(--success)] text-[color:var(--success-fg)] text-[12.5px] font-medium tracking-tight",
            "hover:bg-[var(--success-hover)] transition-colors",
            "aria-[disabled=true]:bg-[var(--bg-subtle)] aria-[disabled=true]:text-[color:var(--text-tertiary)] aria-[disabled=true]:opacity-60",
            "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]",
          )}
        >
          <Save className="h-3.5 w-3.5" />
          Save
        </button>
      </Tooltip>
    </div>
  );
}
