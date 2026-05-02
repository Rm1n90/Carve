// Armin Mehri — mehri.armin@gmail.com
import { useEffect, type ReactNode } from "react";
import { MousePointer2, Square, Pentagon, Brush, Tag, Wand2 } from "lucide-react";
import { useTool, type ToolName } from "@/state/tool";
import { cn } from "@/lib/cn";

interface ToolDef {
  name: ToolName;
  label: string;
  hotkey: string;
  icon: ReactNode;
}

const TOOLS: ToolDef[] = [
  { name: "cursor", label: "Select", hotkey: "V", icon: <MousePointer2 className="h-[18px] w-[18px]" /> },
  { name: "bbox", label: "Bounding box", hotkey: "B", icon: <Square className="h-[18px] w-[18px]" /> },
  { name: "polygon", label: "Polygon", hotkey: "P", icon: <Pentagon className="h-[18px] w-[18px]" /> },
  { name: "mask", label: "Mask brush", hotkey: "M", icon: <Brush className="h-[18px] w-[18px]" /> },
  { name: "tag", label: "Tag", hotkey: "T", icon: <Tag className="h-[18px] w-[18px]" /> },
  { name: "sam", label: "Magic wand (SAM)", hotkey: "S", icon: <Wand2 className="h-[18px] w-[18px]" /> },
];

/**
 * Standalone tool dock used in tests / SAM-tool tests. The editor page
 * itself uses `EditorToolbar` (a horizontal strip with save status).
 */
export function Toolbar() {
  const active = useTool((s) => s.active);
  const setActive = useTool((s) => s.setActive);

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
    <aside
      role="toolbar"
      aria-label="Annotation tools"
      className={cn(
        "flex w-12 shrink-0 flex-col items-center gap-1 px-1 py-2",
        "border-r border-[var(--border-subtle)] bg-[var(--bg-app)]",
      )}
    >
      {TOOLS.map((t) => {
        const isActive = active === t.name;
        return (
          <button
            key={t.name}
            type="button"
            aria-label={`${t.label} (${t.hotkey})`}
            aria-pressed={isActive}
            onClick={() => setActive(t.name)}
            title={`${t.label} — ${t.hotkey}`}
            className={cn(
              "grid h-8 w-8 place-items-center rounded-[var(--radius-sm)] transition-colors",
              "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]",
              isActive
                ? "bg-[var(--accent-bg)] text-[color:var(--accent)]"
                : "text-[color:var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[color:var(--text-primary)]",
            )}
          >
            {t.icon}
          </button>
        );
      })}
    </aside>
  );
}
