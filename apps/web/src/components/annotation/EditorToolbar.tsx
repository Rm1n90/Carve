import { useEffect, type ReactNode } from "react";
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
  Loader2,
  AlertCircle,
  CheckCircle2,
} from "lucide-react";
import { useTool, type ToolName } from "@/state/tool";
import { Tooltip } from "@/components/ui/Tooltip";
import { Kbd } from "@/components/ui/Kbd";
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

interface EditorToolbarProps {
  onSave: () => void;
  isSaving: boolean;
  hasError: boolean;
  dirtyCount: number;
  onFitToScreen?: () => void;
  onToggleVisibility?: () => void;
  visibilityOn?: boolean;
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
    <Tooltip
      content={
        <span className="flex items-center gap-1.5">
          {label}
          <Kbd className="bg-white/10 text-white border-white/20">{hotkey}</Kbd>
        </span>
      }
    >
      <button
        type="button"
        onClick={onClick}
        aria-label={`${label} (${hotkey})`}
        aria-pressed={active}
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
    </Tooltip>
  );
}

function SaveStatus({
  isSaving,
  hasError,
  dirtyCount,
}: Pick<EditorToolbarProps, "isSaving" | "hasError" | "dirtyCount">) {
  if (isSaving) {
    return (
      <span className="inline-flex items-center gap-1.5 text-[11.5px] text-[color:var(--accent)] tracking-tight">
        <Loader2 className="h-3 w-3 animate-spin" />
        Saving
      </span>
    );
  }
  if (hasError) {
    return (
      <span className="inline-flex items-center gap-1.5 text-[11.5px] text-[color:var(--danger)] tracking-tight">
        <AlertCircle className="h-3 w-3" />
        Save failed
      </span>
    );
  }
  if (dirtyCount > 0) {
    return (
      <span className="inline-flex items-center gap-1.5 text-[11.5px] text-[color:var(--warning)] tracking-tight">
        <span className="h-1.5 w-1.5 rounded-full bg-[var(--warning)]" />
        {dirtyCount} unsaved
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-[11.5px] text-[color:var(--success)] tracking-tight">
      <CheckCircle2 className="h-3 w-3" />
      Saved
    </span>
  );
}

/**
 * Editor toolbar — 40px horizontal strip under TopBar. Left: tool icons.
 * Right: visibility/filter/fit-to-screen toggles, save status, green Save pill.
 */
export function EditorToolbar({
  onSave,
  isSaving,
  hasError,
  dirtyCount,
  onFitToScreen,
  onToggleVisibility,
  visibilityOn = true,
}: EditorToolbarProps) {
  const active = useTool((s) => s.active);
  const setActive = useTool((s) => s.setActive);

  // Single-letter hotkeys (V/B/P/M/T/S) trigger tool selection.
  useEffect(() => {
    function handler(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      const match = TOOLS.find((tool) => tool.hotkey.toLowerCase() === e.key.toLowerCase());
      if (match) {
        setActive(match.name);
      }
    }
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [setActive]);

  return (
    <div
      role="toolbar"
      aria-label="Annotation tools"
      className={cn(
        "h-10 shrink-0 flex items-center gap-1 px-2",
        "border-b border-[var(--border-subtle)] bg-[var(--bg-app)]",
      )}
    >
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

      <Tooltip content={visibilityOn ? "Hide annotations" : "Show annotations"}>
        <button
          type="button"
          onClick={onToggleVisibility}
          aria-label="Toggle annotation visibility"
          aria-pressed={visibilityOn}
          className={cn(
            "grid h-8 w-8 place-items-center rounded-[var(--radius-sm)] transition-colors",
            visibilityOn
              ? "text-[color:var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[color:var(--text-primary)]"
              : "bg-[var(--bg-hover)] text-[color:var(--text-tertiary)]",
          )}
        >
          <Eye className="h-[18px] w-[18px]" />
        </button>
      </Tooltip>

      <Tooltip content="Filter">
        <button
          type="button"
          aria-label="Filter"
          className="grid h-8 w-8 place-items-center rounded-[var(--radius-sm)] text-[color:var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[color:var(--text-primary)] transition-colors"
        >
          <Filter className="h-[18px] w-[18px]" />
        </button>
      </Tooltip>

      <Tooltip content="Fit to screen">
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

      <SaveStatus isSaving={isSaving} hasError={hasError} dirtyCount={dirtyCount} />

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
          className={cn(
            "ml-2 inline-flex h-8 items-center gap-1.5 px-3 rounded-full",
            "bg-[var(--success)] text-white text-[12.5px] font-medium tracking-tight",
            "hover:bg-[var(--success-hover)] transition-colors",
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
