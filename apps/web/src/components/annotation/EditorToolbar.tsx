import { useEffect, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
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
} from "lucide-react";
import { EditorSettingsDialog } from "@/components/annotation/EditorSettingsDialog";
import { FilterBuilderDialog } from "@/components/annotation/FilterBuilderDialog";
import { SamVariantSwitcher } from "@/components/annotation/SamVariantSwitcher";
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
} from "@/api/phase2";
import { projectsApi, type Project } from "@/api/projects";
import { showToast } from "@/lib/toast";
import { cn } from "@/lib/cn";

const PREDICT_CONF_KEY = "carve.predict.minConfidence";
const DEFAULT_PREDICT_CONFIDENCE = 0.4;
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

function YoloPredictButton({
  projectId,
  taskId,
  assetId,
  onAfter,
}: {
  projectId?: string;
  taskId?: string;
  assetId?: string;
  onAfter?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [overwrite, setOverwrite] = useState(false);
  const [confidence, setConfidence] = useState<number>(() => loadStoredConfidence());
  // v3.5 Phase F3 — per-weight-class binding picked by the user in the
  // disclosure. Keyed by `weight_class_idx` (string) so the wire shape
  // matches the API. `null` means "skip this weight class on predict".
  const [overrides, setOverrides] = useState<Record<string, string | null>>({});
  const [overridesExpanded, setOverridesExpanded] = useState(false);

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

  const wq = useQuery<Weight[]>({
    queryKey: ["weights", projectId],
    queryFn: () => (projectId ? weightsApi.listForProject(projectId) : Promise.resolve([])),
    enabled: !!projectId && open,
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

  // v3.3 Issue 4 — when the popover opens, pre-select the project's
  // last-used weight (if still present) or fall back to the project
  // default. Runs once per open transition and only when nothing is
  // currently selected so reopening after a manual choice doesn't
  // overwrite the user's pick.
  useEffect(() => {
    if (!open) return;
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
  }, [open, selected, wq.data, projectId]);

  // v3.5 Phase F3 — fetch class-mapping suggestions once the user picks
  // a weight. Read-only on the API; computed per `(weight, task)` from
  // case-insensitive name match against the task's allowed classes.
  const sugQ = useQuery({
    queryKey: ["mapping-suggestions", selected, taskId],
    queryFn: () =>
      selected && taskId
        ? weightsApi.getMappingSuggestions(selected, taskId)
        : Promise.resolve({ suggestions: [] }),
    enabled: open && !!selected && !!taskId,
  });
  const suggestions: MappingSuggestion[] = sugQ.data?.suggestions ?? [];

  // v3.5 Phase F3 — once suggestions land, seed the override state:
  // first check the per-`(weight, task)` localStorage cache (so the
  // user's last picks pre-fill), otherwise fall back to the auto-name
  // matched suggestion. Skipping (None) is represented by `null`.
  useEffect(() => {
    if (!open) return;
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
  }, [open, selected, taskId, sugQ.data]);

  const matchedCount = suggestions.reduce((acc, s) => {
    const v = overrides[String(s.weight_class_idx)];
    return acc + (v !== null && v !== undefined ? 1 : 0);
  }, 0);

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
      );
    },
    onSuccess: (res, weightId) => {
      const created = res?.annotations_created ?? res?.count ?? 0;
      const skipped = res?.skipped_count ?? 0;
      const unmappedClasses = Object.keys(res?.skipped_by_class ?? {});
      if (created === 0 && skipped === 0) {
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
      setOpen(false);
      onAfter?.();
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

  function handlePredict() {
    if (!selected) {
      showToast("Select a weight first.", { variant: "error" });
      return;
    }
    if (!assetId) {
      showToast("No asset open.", { variant: "error" });
      return;
    }
    m.mutate(selected);
  }

  const weights = wq.data ?? [];
  const disabled = !projectId || !assetId;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="yolo-predict-trigger"
          aria-label="Open YOLO predict"
          title="Predict with YOLO weight"
          disabled={disabled || m.isPending}
          className={cn(
            "inline-flex h-8 items-center gap-1.5 px-3 rounded-full",
            "bg-[var(--success)] text-white text-[12.5px] font-medium tracking-tight",
            "hover:bg-[var(--success-hover)] transition-colors",
            "disabled:bg-[var(--bg-subtle)] disabled:text-[color:var(--text-tertiary)] disabled:cursor-not-allowed",
          )}
        >
          {m.isPending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Sparkles className="h-3.5 w-3.5" />
          )}
          {m.isPending ? "Predicting…" : "Predict"}
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
        <div className="flex justify-end gap-1.5 pt-1">
          {m.isError && (
            <span className="inline-flex items-center gap-1 text-[11px] text-[color:var(--danger)] mr-auto">
              <AlertTriangle className="h-3 w-3" /> Failed
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
            disabled={!selected || m.isPending}
            onClick={handlePredict}
            data-testid="yolo-predict-go"
            className={cn(
              "inline-flex items-center gap-1.5 h-7 px-3 rounded-full",
              "bg-[var(--success)] text-white text-[12px] font-medium",
              "disabled:bg-[var(--bg-subtle)] disabled:text-[color:var(--text-tertiary)] disabled:cursor-not-allowed",
              "enabled:hover:bg-[var(--success-hover)]",
            )}
          >
            {m.isPending ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Sparkles className="h-3 w-3" />
            )}
            {m.isPending ? "Predicting…" : "Predict"}
          </button>
        </div>
      </PopoverContent>
    </Popover>
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
  const presets = [5, 10, 25, 50, 100];
  if (active !== "mask") return null;
  return (
    <div
      className="inline-flex items-center gap-1.5 h-8 px-2 rounded-[var(--radius-sm)] bg-[var(--bg-subtle)]"
      data-testid="mask-brush-size-control"
    >
      <span className="text-[10.5px] uppercase tracking-[0.10em] text-[color:var(--text-tertiary)]">
        Brush
      </span>
      <input
        type="range"
        min={1}
        max={100}
        step={1}
        value={Math.min(100, Math.max(1, radius))}
        onChange={(e) => setRadius(Number(e.target.value))}
        aria-label="Brush radius"
        data-testid="mask-brush-size-slider"
        className="w-24 accent-[var(--accent)]"
      />
      <span
        className="font-mono tabular-nums text-[11.5px] text-[color:var(--text-primary)] w-8 text-right"
        data-testid="mask-brush-size-value"
      >
        {radius}px
      </span>
      <span className="hidden sm:inline-flex items-center gap-1 ml-1">
        {presets.map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => setRadius(p)}
            data-testid={`mask-brush-preset-${p}`}
            className={cn(
              "h-6 px-1.5 rounded-[var(--radius-xs)] text-[10.5px] font-mono",
              radius === p
                ? "bg-[var(--accent)] text-[color:var(--accent-fg)]"
                : "text-[color:var(--text-secondary)] hover:bg-[var(--bg-hover)]",
            )}
          >
            {p}
          </button>
        ))}
      </span>
    </div>
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
    { id: "box", label: "Box", sam3Only: true, videoOnly: false },
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
        <span className="flex items-center gap-1.5">
          Auto-apply
          <Kbd className="bg-white/10 text-white border-white/20">A</Kbd>
        </span>
      }
    >
      <button
        type="button"
        data-testid="auto-apply-toggle"
        aria-label="Toggle auto-apply"
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

  // Single-letter hotkeys (V/B/P/M/T/S/A/F) trigger tool selection,
  // plus zoom-related keys: + / - / 0 / 1 / Cmd|Ctrl + + / -. v2.6 zoom.
  useEffect(() => {
    function handler(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      // Cmd / Ctrl + (+ / -) — match the browser default keys but route
      // them through the canvas instead of letting the page zoom. The
      // user expects ⌘+ to zoom the image, not the whole tab.
      if ((e.metaKey || e.ctrlKey) && !e.altKey) {
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

      <span aria-hidden className="mx-1 h-5 w-px bg-[var(--glass-border-strong)]" />

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
        projectId={projectId}
        taskId={taskId}
        assetId={assetId}
        onAfter={onAfterYoloPredict}
      />

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
      <FilterBuilderDialog
        open={filterDialogOpen}
        onOpenChange={setFilterDialogOpen}
      />

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
      <EditorSettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />

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
