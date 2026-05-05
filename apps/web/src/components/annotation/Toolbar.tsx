// Armin Mehri — mehri.armin@gmail.com
import { type ReactNode } from "react";
import { MousePointer2, Square, Pentagon, Brush, Tag, Wand2 } from "lucide-react";
import { useTool, type ToolName } from "@/state/tool";
import { cn } from "@/lib/cn";
import { chordTokens } from "@/lib/shortcuts/chord";
import { useShortcut, useShortcutHandler } from "@/state/shortcuts";

interface ToolDef {
  name: ToolName;
  label: string;
  /** Action id in the shortcut registry. Drives the live chord lookup. */
  actionId: string;
  icon: ReactNode;
}

const TOOLS: ToolDef[] = [
  { name: "cursor", label: "Select", actionId: "tool_cursor", icon: <MousePointer2 className="h-[18px] w-[18px]" /> },
  { name: "bbox", label: "Bounding box", actionId: "tool_bbox", icon: <Square className="h-[18px] w-[18px]" /> },
  { name: "polygon", label: "Polygon", actionId: "tool_polygon", icon: <Pentagon className="h-[18px] w-[18px]" /> },
  { name: "mask", label: "Mask brush", actionId: "tool_mask", icon: <Brush className="h-[18px] w-[18px]" /> },
  { name: "tag", label: "Tag", actionId: "tool_tag", icon: <Tag className="h-[18px] w-[18px]" /> },
  { name: "sam", label: "Magic wand (SAM)", actionId: "tool_sam", icon: <Wand2 className="h-[18px] w-[18px]" /> },
];

/**
 * Standalone tool dock used in tests / SAM-tool tests. The editor page
 * itself uses `EditorToolbar` (a horizontal strip with save status).
 *
 * v3.21 -- per-tool keyboard activation is routed through
 * ``useShortcutHandler`` so the user can rebind the chord. The hotkey
 * shown in the tooltip is computed from the live registry chord.
 */
export function Toolbar() {
  const active = useTool((s) => s.active);
  const setActive = useTool((s) => s.setActive);

  return (
    <aside
      role="toolbar"
      aria-label="Annotation tools"
      className={cn(
        "flex w-12 shrink-0 flex-col items-center gap-1 px-1 py-2",
        "border-r border-[var(--border-subtle)] bg-[var(--bg-app)]",
      )}
    >
      {TOOLS.map((t) => (
        <ToolDockButton
          key={t.name}
          def={t}
          isActive={active === t.name}
          onSelect={() => setActive(t.name)}
        />
      ))}
    </aside>
  );
}

function ToolDockButton({
  def,
  isActive,
  onSelect,
}: {
  def: ToolDef;
  isActive: boolean;
  onSelect: () => void;
}) {
  const chord = useShortcut(def.actionId);
  // Each tool registers its own keydown listener; chord comes from the
  // registry so user overrides apply immediately on next keystroke.
  useShortcutHandler(
    def.actionId,
    () => {
      onSelect();
    },
    { preventDefault: false },
  );
  const tokens = chord ? chordTokens(chord).join("") : "Unbound";
  return (
    <button
      type="button"
      aria-label={`${def.label} (${tokens})`}
      aria-pressed={isActive}
      onClick={onSelect}
      title={`${def.label} — ${tokens}`}
      className={cn(
        "grid h-8 w-8 place-items-center rounded-[var(--radius-sm)] transition-colors",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]",
        isActive
          ? "bg-[var(--accent-bg)] text-[color:var(--accent)]"
          : "text-[color:var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[color:var(--text-primary)]",
      )}
    >
      {def.icon}
    </button>
  );
}
