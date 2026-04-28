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
import { useFilter } from "@/state/annotationFilter";
import { hasMeaningfulRules } from "@/lib/annotation-filter";
import { useTool, type ToolName, type VisibilityFlags } from "@/state/tool";
import { useAnnotations } from "@/state/annotations";
import { Tooltip } from "@/components/ui/Tooltip";
import { Kbd } from "@/components/ui/Kbd";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/Popover";
import { SaveIndicator } from "@/components/annotation/SaveIndicator";
import { modelsApi, weightsApi, inferenceApi, type Weight } from "@/api/phase2";
import { showToast } from "@/lib/toast";
import { cn } from "@/lib/cn";

const PREDICT_CONF_KEY = "carve.predict.minConfidence";
const DEFAULT_PREDICT_CONFIDENCE = 0.4;

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

const VARIANT_NOTES: Record<string, string> = {
  "sam2.1-tiny": "Tiny — fastest",
  "sam2.1-small": "Small — balanced",
  "sam2.1-base+": "Base+ — accurate",
  "sam2.1-large": "Large — best quality",
  sam3: "SAM 3 — preview",
};

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
  assetId?: string;
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

function SamModelPicker() {
  const q = useQuery({
    queryKey: ["sam-active"],
    queryFn: () => modelsApi.samActive(),
  });
  const active = q.data?.active ?? "sam2.1-base+";
  const available = q.data?.available ?? [];
  // The picker has no runtime mutation — switching SAM_MODEL requires a
  // service restart. We treat any of: query error, empty available list,
  // or explicit reachable=false as "model service is not reachable" and
  // show a banner. (audit bug 8b; v2.3 phase B refines with the explicit
  // `reachable` field returned by the API.)
  const unreachable =
    !!q.error ||
    (q.isFetched && available.length === 0) ||
    (q.isFetched && q.data?.reachable === false);

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
        <p className="px-2 py-1.5 text-[10.5px] uppercase tracking-[0.10em] text-[color:var(--text-tertiary)]">
          SAM model
        </p>
        {unreachable && (
          <div
            data-testid="sam-picker-unreachable-banner"
            className="mx-1 mb-1 px-2 py-2 text-[11.5px] rounded-[var(--radius-xs)] bg-[var(--bg-subtle)] text-[color:var(--text-secondary)] flex items-start gap-1.5"
          >
            <AlertTriangle className="h-3.5 w-3.5 mt-0.5 text-[color:var(--danger)] shrink-0" />
            <span>
              Model service is not running. Start it with
              <code className="mx-1 px-1 py-0.5 rounded bg-[var(--bg-app)] text-[10.5px] font-mono">
                docker compose --profile inference up -d
              </code>
              .
            </span>
          </div>
        )}
        {q.isLoading && !unreachable ? (
          <p className="px-2 py-2 text-[12px] text-[color:var(--text-tertiary)] italic">
            Loading…
          </p>
        ) : (
          available.map((name) => (
            <div
              key={name}
              role="listitem"
              aria-label={`${name}${name === active ? " (active)" : ""}`}
              data-testid={`sam-variant-${name}`}
              data-active={name === active ? "true" : undefined}
              className={cn(
                "w-full flex items-center gap-2 px-2 py-1.5 rounded-[var(--radius-xs)]",
                "text-[12.5px] tracking-tight outline-none",
                name === active ? "bg-[var(--accent-bg)]" : "",
              )}
            >
              {name === active ? (
                <Check className="h-3.5 w-3.5 text-[color:var(--accent)]" />
              ) : (
                <span className="h-3.5 w-3.5" aria-hidden />
              )}
              <span className="flex-1">{name}</span>
              <span className="text-[10.5px] text-[color:var(--text-tertiary)]">
                {VARIANT_NOTES[name] ?? ""}
              </span>
              {name === active && (
                <span className="text-[9.5px] uppercase tracking-[0.10em] px-1.5 py-0.5 rounded bg-[var(--accent)] text-[color:var(--accent-fg)] font-medium">
                  active
                </span>
              )}
            </div>
          ))
        )}
        <p className="px-2 py-2 mt-1 border-t border-[var(--border-subtle)] text-[11px] text-[color:var(--text-tertiary)] leading-snug">
          To change the active SAM variant, set{" "}
          <code className="px-1 py-0.5 rounded bg-[var(--bg-subtle)] text-[10.5px] font-mono">
            SAM_MODEL
          </code>{" "}
          in your model service{" "}
          <code className="px-1 py-0.5 rounded bg-[var(--bg-subtle)] text-[10.5px] font-mono">
            .env
          </code>{" "}
          and restart it.
        </p>
      </PopoverContent>
    </Popover>
  );
}

function YoloPredictButton({
  projectId,
  assetId,
  onAfter,
}: {
  projectId?: string;
  assetId?: string;
  onAfter?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [overwrite, setOverwrite] = useState(false);
  const [confidence, setConfidence] = useState<number>(() => loadStoredConfidence());

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

  const m = useMutation({
    mutationFn: (weightId: string) =>
      assetId
        ? inferenceApi.predictYolo(assetId, weightId, overwrite, confidence)
        : Promise.reject(new Error("no asset")),
    onSuccess: (res) => {
      const created = res?.count ?? 0;
      if (created === 0) {
        showToast(
          `No detections at confidence ${(confidence * 100).toFixed(0)}%`,
          { variant: "warning" },
        );
      } else {
        showToast(`Created ${created} annotations from predictions`, {
          variant: "success",
        });
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
            <p className="px-2 py-2 text-[12px] text-[color:var(--text-tertiary)] italic">
              No weights uploaded for this project yet.
            </p>
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
            >
              {selected === w.id ? (
                <Check className="h-3.5 w-3.5 text-[color:var(--accent)]" />
              ) : (
                <span className="h-3.5 w-3.5" aria-hidden />
              )}
              <span className="flex-1 truncate">{w.name}</span>
              <span className="text-[10px] uppercase tracking-wider text-[color:var(--text-tertiary)]">
                {w.task_kind}
              </span>
            </button>
          ))}
        </div>
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
  assetId,
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
