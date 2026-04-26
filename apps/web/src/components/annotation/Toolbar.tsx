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
        "flex w-14 shrink-0 flex-col items-center gap-1 px-2 py-3",
        "border-r border-[var(--border-subtle)]",
        "bg-[var(--bg-glass-strong)] backdrop-blur-xl",
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
              "relative grid h-10 w-10 place-items-center rounded-[var(--radius-md)]",
              "transition-all duration-150",
              "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]",
              isActive
                ? "bg-[var(--accent-bg)] text-[var(--accent)] border border-[var(--border-accent)] shadow-[0_0_0_1px_var(--border-accent),_0_0_18px_oklch(0.78_0.16_215_/_0.18)]"
                : "bg-transparent text-secondary border border-transparent hover:bg-[var(--bg-surface)] hover:text-primary",
            )}
          >
            {t.icon}
          </button>
        );
      })}
    </aside>
  );
}
