import { useEffect, useState, type ReactNode } from "react";
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
} from "lucide-react";
import { useTool, type ToolName, type VisibilityFlags } from "@/state/tool";
import { useAnnotations } from "@/state/annotations";
import { Tooltip } from "@/components/ui/Tooltip";
import { Kbd } from "@/components/ui/Kbd";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/Popover";
import { SaveIndicator } from "@/components/annotation/SaveIndicator";
import { modelsApi, weightsApi, inferenceApi, type Weight } from "@/api/phase2";
import { cn } from "@/lib/cn";

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
  onUndo?: () => void;
  onRedo?: () => void;
  zoomPct?: number;
  /** Only present when an asset is open. */
  projectId?: string;
  assetId?: string;
  /** Optional: legacy prop, single-on toggle of all annotations. */
  visibilityOn?: boolean;
  onToggleVisibility?: () => void;
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
        "grid h-8 w-8 place-items-center rounded-[var(--radius-sm)] transition-colors",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]",
        active
          ? "bg-[var(--accent-bg)] text-[color:var(--accent)]"
          : "text-[color:var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[color:var(--text-primary)]",
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
      <PopoverContent align="end" className="min-w-[260px] p-1">
        <p className="px-2 py-1.5 text-[10.5px] uppercase tracking-[0.10em] text-[color:var(--text-tertiary)]">
          SAM model
        </p>
        {available.length === 0 ? (
          <p className="px-2 py-2 text-[12px] text-[color:var(--text-tertiary)] italic">
            Loading…
          </p>
        ) : (
          available.map((name) => (
            <button
              key={name}
              type="button"
              onClick={() => {
                window.alert(
                  "To switch SAM variant: edit SAM_MODEL in the model service .env and restart it.",
                );
              }}
              className={cn(
                "w-full flex items-center gap-2 px-2 py-1.5 rounded-[var(--radius-xs)]",
                "text-[12.5px] tracking-tight cursor-pointer outline-none",
                "hover:bg-[var(--bg-hover)] data-[active=true]:bg-[var(--accent-bg)]",
              )}
              data-active={name === active ? "true" : undefined}
              data-testid={`sam-variant-${name}`}
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
            </button>
          ))
        )}
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

  const wq = useQuery<Weight[]>({
    queryKey: ["weights", projectId],
    queryFn: () => (projectId ? weightsApi.listForProject(projectId) : Promise.resolve([])),
    enabled: !!projectId && open,
  });

  const m = useMutation({
    mutationFn: (weightId: string) =>
      assetId
        ? inferenceApi.predictYolo(assetId, weightId, overwrite)
        : Promise.reject(new Error("no asset")),
    onSuccess: () => {
      setOpen(false);
      onAfter?.();
    },
  });

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
          disabled={disabled}
          className={cn(
            "inline-flex h-8 items-center gap-1.5 px-3 rounded-full",
            "bg-[var(--success)] text-white text-[12.5px] font-medium tracking-tight",
            "hover:bg-[var(--success-hover)] transition-colors",
            "disabled:bg-[var(--bg-subtle)] disabled:text-[color:var(--text-tertiary)] disabled:cursor-not-allowed",
          )}
        >
          <Sparkles className="h-3.5 w-3.5" />
          Predict
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="min-w-[300px] p-2">
        <p className="px-1 py-1 text-[10.5px] uppercase tracking-[0.10em] text-[color:var(--text-tertiary)]">
          YOLO weight
        </p>
        <div className="grid gap-1 max-h-[260px] overflow-y-auto pr-1">
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
            onClick={() => selected && m.mutate(selected)}
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
            Predict
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
          className="z-[1000] min-w-[220px] rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-elev)] shadow-[var(--shadow-elev-2)] p-1"
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
            ? "bg-[#DCFCE7] border-[var(--success)] text-[var(--success)]"
            : "border-transparent text-[color:var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[color:var(--text-primary)]",
        )}
      >
        <Wand2 className="h-[18px] w-[18px]" />
      </button>
    </Tooltip>
  );
}

function ZoomControls({
  zoomPct,
  onZoomIn,
  onZoomOut,
  onZoomTo,
}: {
  zoomPct?: number;
  onZoomIn?: () => void;
  onZoomOut?: () => void;
  onZoomTo?: (p: number) => void;
}) {
  const z = zoomPct ?? 100;
  return (
    <div className="flex items-center gap-0.5" data-testid="zoom-controls">
      <Tooltip content="Zoom out">
        <button
          type="button"
          onClick={onZoomOut}
          aria-label="Zoom out"
          className="grid h-8 w-7 place-items-center rounded-[var(--radius-sm)] text-[color:var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[color:var(--text-primary)]"
        >
          <Minus className="h-3.5 w-3.5" />
        </button>
      </Tooltip>
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            data-testid="zoom-percent"
            aria-label="Zoom level"
            title="Zoom level"
            className="h-8 px-2 rounded-[var(--radius-sm)] font-mono text-[11.5px] text-[color:var(--text-secondary)] tabular-nums hover:bg-[var(--bg-hover)] hover:text-[color:var(--text-primary)]"
          >
            {Math.round(z)}%
          </button>
        </PopoverTrigger>
        <PopoverContent align="center" className="min-w-[160px] p-1">
          {[50, 100, 200].map((p) => (
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
      <Tooltip content="Zoom in">
        <button
          type="button"
          onClick={onZoomIn}
          aria-label="Zoom in"
          className="grid h-8 w-7 place-items-center rounded-[var(--radius-sm)] text-[color:var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[color:var(--text-primary)]"
        >
          <Plus className="h-3.5 w-3.5" />
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

  // Single-letter hotkeys (V/B/P/M/T/S/A/F) trigger tool selection.
  useEffect(() => {
    function handler(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
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
  }, [setActive, toggleAutoApply, onFitToScreen]);

  return (
    <div
      role="toolbar"
      aria-label="Annotation tools"
      className={cn(
        "h-10 shrink-0 flex items-center gap-1 px-2",
        "border-b border-[var(--border-subtle)] bg-[var(--bg-app)]",
      )}
    >
      <UndoRedoControls onUndo={onUndo} onRedo={onRedo} />

      <span aria-hidden className="mx-1 h-5 w-px bg-[var(--border-subtle)]" />

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

      <span aria-hidden className="mx-1 h-5 w-px bg-[var(--border-subtle)]" />

      <SamModelPicker />
      <AutoApplyToggle />

      <span aria-hidden className="mx-1 h-5 w-px bg-[var(--border-subtle)]" />

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
      />

      <span aria-hidden className="mx-1 h-5 w-px bg-[var(--border-subtle)]" />

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
            "bg-[var(--success)] text-white text-[12.5px] font-medium tracking-tight",
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
